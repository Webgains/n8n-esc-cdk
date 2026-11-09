import {
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  aws_ec2 as ec2,
  aws_iam as iam,
  aws_ssm as ssm,
} from "aws-cdk-lib";
import { IVpc } from "aws-cdk-lib/aws-ec2";
import {
  Cluster,
  ContainerDependencyCondition,
  ContainerImage,
  FargateTaskDefinition,
  LogDrivers,
  Secret as EcsSecret,
} from "aws-cdk-lib/aws-ecs";
import { ScheduledFargateTask } from "aws-cdk-lib/aws-ecs-patterns";
import { Schedule } from "aws-cdk-lib/aws-events";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Bucket, BucketEncryption, BlockPublicAccess } from "aws-cdk-lib/aws-s3";
import { ISecret, Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { ParameterHelper } from "@/utils/parameter-helper";
import { N8N_IMAGE } from "@/utils/n8n-image";

export interface N8nBackupStackProps extends StackProps {
  readonly prefix: string;
  readonly parameterHelper: ParameterHelper;
  readonly vpc: IVpc;
}

export class N8nBackupStack extends Stack {
  constructor(scope: Construct, id: string, props: N8nBackupStackProps) {
    super(scope, id, props);

    const clusterName = ssm.StringParameter.valueFromLookup(
      this,
      props.parameterHelper.ecsClusterName()
    );
    const dbHost = ssm.StringParameter.valueFromLookup(
      this,
      props.parameterHelper.postgresHost()
    );
    const dbPort = ssm.StringParameter.valueFromLookup(
      this,
      props.parameterHelper.postgresPort()
    );
    const dbName = ssm.StringParameter.valueFromLookup(
      this,
      props.parameterHelper.postgresN8nDatabase()
    );
    const dbAppSecret = Secret.fromSecretNameV2(
      this,
      "DbAppSecret",
      props.parameterHelper.postgresAppSecretName()
    );

    const bucket = new Bucket(this, "BackupBucket", {
      bucketName: `${props.prefix}-backups-${this.account}`,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      versioned: true,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          expiration: Duration.days(30),
          noncurrentVersionExpiration: Duration.days(7),
        },
      ],
    });

    const logGroup = new LogGroup(this, "BackupLogGroup", {
      logGroupName: `/ecs/${props.prefix}/postgres-backup`,
      retention: RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const executionRole = new iam.Role(this, "BackupExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Execution role for the n8n Postgres backup task",
    });
    // grantWrite targets the log group ARN. CreateLogStream and PutLogEvents
    // authorize against the stream ARN, which is that ARN plus ":*".
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [`${logGroup.logGroupArn}:*`],
      })
    );

    const taskRole = new iam.Role(this, "BackupTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Task role for the n8n Postgres backup task",
    });
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [bucket.arnForObjects("*")],
      })
    );

    const taskDefinition = new FargateTaskDefinition(this, "BackupTaskDef", {
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole,
      taskRole,
      family: `${props.prefix}-postgres-backup`,
    });

    taskDefinition.addContainer("postgres-backup", {
      image: ContainerImage.fromRegistry("postgres:16"),
      // The image USER is postgres, which cannot install packages.
      user: "root",
      essential: true,
      entryPoint: ["/bin/bash", "-c"],
      command: [dumpCommand()],
      environment: {
        PGHOST: dbHost,
        PGPORT: dbPort,
        PGDATABASE: dbName,
        BACKUP_BUCKET: bucket.bucketName,
        DEBIAN_FRONTEND: "noninteractive",
      },
      secrets: {
        PGUSER: pgAppSecretField(dbAppSecret, "username"),
        PGPASSWORD: pgAppSecretField(dbAppSecret, "password"),
      },
      logging: LogDrivers.awsLogs({
        streamPrefix: "postgres-backup",
        logGroup,
      }),
    });

    // Same cluster import as the database stack. Private subnets are taken
    // from the VPC that publishes vpcPrivateSubnetsIdParameterName. That SSM
    // value is a list token, which cannot be expanded into task ENIs at synth.
    // Isolated subnets have no route to S3.
    const cluster = Cluster.fromClusterAttributes(this, "ImportedCluster", {
      clusterName,
      vpc: props.vpc,
      securityGroups: [],
    });

    // ecsClusterAccess on the database task already allows the VPC CIDR,
    // which includes these private subnets, so port 5432 needs no new rule.
    const backupSecurityGroup = new ec2.SecurityGroup(
      this,
      "BackupTaskSecurityGroup",
      {
        vpc: props.vpc,
        securityGroupName: `${props.prefix}-postgres-backup-sg`,
        description: "Egress for the n8n Postgres backup task",
        allowAllOutbound: true,
      }
    );

    new ScheduledFargateTask(this, "PostgresBackup", {
      cluster,
      schedule: Schedule.cron({ minute: "15", hour: "2" }),
      subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [backupSecurityGroup],
      scheduledFargateTaskDefinitionOptions: { taskDefinition },
    });

    // The n8n CLI runs in its own container and writes to a shared ephemeral
    // volume. The AWS CLI container uploads only after the export exits 0.
    // The encryption key is not injected, so credentials stay encrypted.
    const exportVolume = "n8n-export";
    const exportTaskDefinition = new FargateTaskDefinition(
      this,
      "N8nExportTaskDef",
      {
        cpu: 512,
        memoryLimitMiB: 1024,
        executionRole,
        taskRole,
        family: `${props.prefix}-n8n-cli-export`,
        volumes: [{ name: exportVolume }],
      }
    );

    const n8nExport = exportTaskDefinition.addContainer("n8n-export", {
      image: ContainerImage.fromRegistry(N8N_IMAGE),
      // The image runs as node, but the ephemeral volume is root-owned, so mkdir needs root.
      user: "root",
      essential: false,
      entryPoint: ["sh", "-c"],
      command: [exportCommand()],
      environment: {
        DB_TYPE: "postgresdb",
        DB_POSTGRESDB_HOST: dbHost,
        DB_POSTGRESDB_PORT: dbPort,
        DB_POSTGRESDB_DATABASE: dbName,
      },
      secrets: {
        DB_POSTGRESDB_USER: pgAppSecretField(dbAppSecret, "username"),
        DB_POSTGRESDB_PASSWORD: pgAppSecretField(dbAppSecret, "password"),
      },
      logging: LogDrivers.awsLogs({
        streamPrefix: "n8n-export",
        logGroup,
      }),
    });
    n8nExport.addMountPoints({
      sourceVolume: exportVolume,
      containerPath: "/export",
      readOnly: false,
    });

    const upload = exportTaskDefinition.addContainer("s3-upload", {
      image: ContainerImage.fromRegistry("amazon/aws-cli:2.39.5"),
      essential: true,
      entryPoint: ["sh", "-c"],
      command: [uploadCommand()],
      environment: { BACKUP_BUCKET: bucket.bucketName },
      logging: LogDrivers.awsLogs({
        streamPrefix: "n8n-export-upload",
        logGroup,
      }),
    });
    upload.addMountPoints({
      sourceVolume: exportVolume,
      containerPath: "/export",
      readOnly: true,
    });
    upload.addContainerDependencies({
      container: n8nExport,
      condition: ContainerDependencyCondition.SUCCESS,
    });

    new ScheduledFargateTask(this, "N8nCliExport", {
      cluster,
      schedule: Schedule.cron({ minute: "30", hour: "2" }),
      subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [backupSecurityGroup],
      scheduledFargateTaskDefinitionOptions: {
        taskDefinition: exportTaskDefinition,
      },
    });
  }
}

// ECS Secret.grantRead also allows DescribeSecret. Injection only needs GetSecretValue.
function pgAppSecretField(secret: ISecret, field: "username" | "password"): EcsSecret {
  const ecsSecret = EcsSecret.fromSecretsManager(secret, field);
  ecsSecret.grantRead = (grantee: iam.IGrantable): iam.Grant =>
    iam.Grant.addToPrincipal({
      grantee,
      actions: ["secretsmanager:GetSecretValue"],
      resourceArns: [`${secret.secretArn}-??????`],
    });
  return ecsSecret;
}

function exportCommand(): string {
  return [
    "set -eu",
    "mkdir -p /export/workflows /export/credentials",
    "n8n export:workflow --backup --output=/export/workflows/",
    "n8n export:credentials --backup --output=/export/credentials/",
  ].join("\n");
}

function uploadCommand(): string {
  return [
    "set -eu",
    "day=$(date -u +%Y/%m/%d)",
    'aws s3 cp /export "s3://${BACKUP_BUCKET}/cli/${day}" --recursive',
  ].join("\n");
}

function dumpCommand(): string {
  return [
    "set -euo pipefail",
    "apt-get update",
    "apt-get install -y awscli",
    "stamp=$(date -u +%Y%m%dT%H%M%SZ)",
    "year=${stamp:0:4}",
    "month=${stamp:4:2}",
    "day=${stamp:6:2}",
    "pg_dump -Fc --no-owner --no-privileges -h \"$PGHOST\" -p \"$PGPORT\" -U \"$PGUSER\" -d \"$PGDATABASE\" -f \"/tmp/n8n-${stamp}.dump\"",
    "aws s3 cp \"/tmp/n8n-${stamp}.dump\" \"s3://${BACKUP_BUCKET}/postgres/n8n/${year}/${month}/${day}/n8n-${stamp}.dump\"",
  ].join("\n");
}
