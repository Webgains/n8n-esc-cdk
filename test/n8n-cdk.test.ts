import * as fs from "fs";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Vpc } from "aws-cdk-lib/aws-ec2";
import { N8nBackupStack } from "../lib/n8n-backup-stack";
import { ParameterHelper } from "../utils/parameter-helper";

test("deploy.sh reads the n8n version from the shared image constant", () => {
  const script = fs.readFileSync("deploy.sh", "utf8");
  expect(script).toContain('IMAGE_FILE="utils/n8n-image.ts"');
  expect(script).toContain(
    "grep -oE 'n8nio/n8n:[^\"]+' \"$IMAGE_FILE\" | head -n 1 | cut -d: -f2 || true"
  );
});

test("backup bucket is private, encrypted, versioned, and retained, and the dump is scheduled", () => {
  const account = "111111111111";
  const region = "eu-west-2";
  const parameterHelper = new ParameterHelper("n8n", "dev");
  const context: Record<string, string> = {};
  const lookup = (parameterName: string, value: string) => {
    context[`ssm:account=${account}:parameterName=${parameterName}:region=${region}`] = value;
  };
  lookup(parameterHelper.ecsClusterName(), "n8n-dev-workflow-cluster");
  lookup(parameterHelper.postgresHost(), "postgres.n8n-dev.internal");
  lookup(parameterHelper.postgresPort(), "5432");
  lookup(parameterHelper.postgresN8nDatabase(), "n8n");

  const app = new App({ context });

  const network = new Stack(app, "Network", { env: { account, region } });
  const vpc = Vpc.fromVpcAttributes(network, "Vpc", {
    vpcId: "vpc-0123456789abcdef0",
    availabilityZones: ["eu-west-2a", "eu-west-2b"],
    privateSubnetIds: ["subnet-11111111", "subnet-22222222"],
    vpcCidrBlock: "10.0.0.0/16",
  });

  const stack = new N8nBackupStack(app, "N8nDevBackupStack", {
    prefix: "n8n-dev",
    parameterHelper,
    vpc,
    env: { account, region },
  });

  const template = Template.fromStack(stack);

  template.hasResource("AWS::S3::Bucket", {
    DeletionPolicy: "Retain",
    UpdateReplacePolicy: "Retain",
    Properties: {
      BucketName: "n8n-dev-backups-111111111111",
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" },
          },
        ],
      },
      VersioningConfiguration: { Status: "Enabled" },
      LifecycleConfiguration: {
        Rules: [
          {
            ExpirationInDays: 30,
            NoncurrentVersionExpiration: { NoncurrentDays: 7 },
            Status: "Enabled",
          },
        ],
      },
    },
  });

  template.resourceCountIs("Custom::S3AutoDeleteObjects", 0);

  template.hasResourceProperties("AWS::S3::BucketPolicy", {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Effect: "Deny",
          Condition: { Bool: { "aws:SecureTransport": "false" } },
        }),
      ]),
    },
  });

  template.hasResourceProperties("AWS::Events::Rule", {
    ScheduleExpression: "cron(15 2 * * ? *)",
    Targets: Match.arrayWith([
      Match.objectLike({
        EcsParameters: Match.objectLike({
          LaunchType: "FARGATE",
          NetworkConfiguration: {
            AwsVpcConfiguration: Match.objectLike({
              AssignPublicIp: "DISABLED",
              Subnets: ["subnet-11111111", "subnet-22222222"],
            }),
          },
        }),
      }),
    ]),
  });

  const rules = template.findResources("AWS::Events::Rule");
  const target = Object.values(rules)[0].Properties.Targets[0];
  expect(target.EcsParameters.EnableExecuteCommand ?? false).toBe(false);

  template.resourceCountIs("AWS::Events::Rule", 2);
  template.hasResourceProperties("AWS::Events::Rule", {
    ScheduleExpression: "cron(30 2 * * ? *)",
  });

  const exportTasks = Object.values(
    template.findResources("AWS::ECS::TaskDefinition")
  ).filter((task) => task.Properties.Family === "n8n-dev-n8n-cli-export");
  expect(exportTasks).toHaveLength(1);
  const containers = exportTasks[0].Properties.ContainerDefinitions;
  const exportText = JSON.stringify(containers);
  expect(exportText).toContain("n8n export:workflow --backup --output=/export/workflows/");
  expect(exportText).toContain("n8n export:credentials --backup --output=/export/credentials/");
  expect(exportText).not.toContain("ENCRYPTION_KEY");

  const n8nContainer = containers.find((c: { Name: string }) => c.Name === "n8n-export");
  expect(n8nContainer.Image).toBe("docker.n8n.io/n8nio/n8n:2.41.2");
  expect(n8nContainer.User).toBe("root");
  const uploadContainer = containers.find((c: { Name: string }) => c.Name === "s3-upload");
  expect(uploadContainer.Image).toBe("amazon/aws-cli:2.39.5");
  expect(uploadContainer.DependsOn).toEqual([
    { Condition: "SUCCESS", ContainerName: "n8n-export" },
  ]);

  template.hasResourceProperties("AWS::Logs::LogGroup", {
    RetentionInDays: 14,
  });

  template.hasResourceProperties("AWS::ECS::TaskDefinition", {
    Cpu: "512",
    Memory: "1024",
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({ Image: "postgres:16" }),
    ]),
  });

  const statements = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
    (policy) => policy.Properties.PolicyDocument.Statement as { Action: string; Resource: unknown }[]
  );
  const s3Actions = statements
    .filter((statement) => JSON.stringify(statement).includes("s3:"))
    .map((statement) => statement.Action);
  const secretActions = statements
    .filter((statement) => JSON.stringify(statement.Resource).includes("AppSecretName"))
    .map((statement) => statement.Action);
  expect(s3Actions).toEqual(["s3:PutObject"]);
  expect(secretActions).toEqual(["secretsmanager:GetSecretValue"]);
  expect(JSON.stringify(statements)).toContain(
    ":secretsmanager:eu-west-2:111111111111:secret:/n8n/dev/PostgreSQL/AppSecretName-??????"
  );
});
