#!/bin/bash
set -euo pipefail

STACK_FILE="lib/n8n-service-stack.ts"
AGENT_MODEL="${AGENT_MODEL:-composer-2.5-fast}"
pre_release=false

if [[ "${1:-}" == "--pre-release" ]]; then
    pre_release=true
    echo "Pre-release flag detected. Will deploy pre-release version."
fi

version_gt() {
    local a=$1 b=$2
    [[ "$a" != "$b" && "$(printf '%s\n%s\n' "$a" "$b" | sort -V | tail -n1)" == "$a" ]]
}

current_version=$(grep -oE 'n8nio/n8n:[^"]+' "$STACK_FILE" | head -n 1 | cut -d: -f2)
if [[ -z "$current_version" ]]; then
    echo "Could not detect current n8n version in $STACK_FILE. Exiting."
    exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
releases_file="$work/releases.json"

page=1
while [[ $page -le 5 ]]; do
    curl -sS -o "$work/page-$page.json" "https://api.github.com/repos/n8n-io/n8n/releases?per_page=100&page=$page"
    count=$(jq 'if type == "array" then length else -1 end' "$work/page-$page.json")
    if [[ "$count" -lt 0 ]]; then
        echo "GitHub API did not return a release list (rate limited?):"
        jq -r '.message // "unknown error"' "$work/page-$page.json"
        exit 1
    fi
    if [[ "$count" -eq 0 ]]; then
        rm -f "$work/page-$page.json"
        break
    fi
    [[ "$count" -lt 100 ]] && break
    page=$((page + 1))
done

jq -s 'add' "$work"/page-*.json > "$releases_file"

latest_release=$(jq -r --argjson pre "$pre_release" \
    '.[] | select(.prerelease == $pre) | .tag_name' "$releases_file" | grep '^n8n@' | sort -V | tail -n 1)

if [[ -z "$latest_release" ]]; then
    echo "No release found. Exiting."
    exit 1
fi

version=${latest_release#n8n@}

echo "Current version: $current_version"
echo "Latest release:  $latest_release ($version)"

if [[ "$current_version" == "$version" ]]; then
    echo "Already on $version. No update needed."
    exit 0
fi

if ! command -v cursor >/dev/null 2>&1; then
    echo "cursor CLI not found. Install it or put cursor on PATH."
    exit 1
fi

changeset="$work/CHANGESET.md"
compare_file="$work/compare.json"

curl -sS -o "$compare_file" "https://api.github.com/repos/n8n-io/n8n/compare/n8n@${current_version}...n8n@${version}"

{
    echo "# n8n upgrade ${current_version} -> ${version}"
    echo
    echo "Compare: https://github.com/n8n-io/n8n/compare/n8n@${current_version}...n8n@${version}"
    echo

    jq -r '"ahead_by: \(.ahead_by // 0)\nstatus: \(.status // "unknown")\ntruncated: \(.truncated // false)\ncommits_in_payload: \((.commits // []) | length)\nfiles_in_payload: \((.files // []) | length)"' "$compare_file"
    echo
    echo "## Commit subjects"
    jq -r '.commits[]?.commit.message | split("\n")[0] | "- " + .' "$compare_file"
    echo
    echo "## Changed files"
    jq -r '.files[]? | "- \(.status // "modified") \(.filename) (+\(.additions // 0)/-\(.deletions // 0))"' "$compare_file"
    echo
    echo "## Release notes"
} > "$changeset"

jq -r --argjson pre "$pre_release" '
    .[]
    | select(.prerelease == $pre)
    | select(.tag_name | startswith("n8n@"))
    | {tag: .tag_name, ver: (.tag_name | ltrimstr("n8n@")), published: (.published_at // "" | split("T")[0]), url: .html_url, body: (.body // "")}
    | @json
' "$releases_file" | while read -r row; do
    ver=$(echo "$row" | jq -r '.ver')
    if version_gt "$ver" "$current_version" && ! version_gt "$ver" "$version"; then
        echo "$row" | jq -r '"\n### \(.tag) (\(.published))\n\(.url)\n\n\(.body)\n"'
    fi
done | sed -e '/<!--/,/-->/d' -e 's/<[^>]*>//g' >> "$changeset"

echo
echo "Summarizing ${current_version} -> ${version} with Cursor (${AGENT_MODEL})..."
echo "----------------------------------------"

cursor agent -p --mode ask --trust --model "$AGENT_MODEL" --workspace "$work" \
    "Read CHANGESET.md. It is the complete n8n GitHub compare plus release notes for upgrading from ${current_version} to ${version}. Write a short operator summary: breaking changes, security, env/config, nodes/integrations, notable features, and anything that could affect a self-hosted ECS/Fargate deployment. Ignore contributor thanks and bot noise. Do not edit files."

echo
echo "----------------------------------------"
echo "Updating $STACK_FILE to $version and deploying."

# iam-assume is sourced into this shell and reads unset vars (IA_EC2), so it
# cannot run under `set -euo pipefail`.
set +eu +o pipefail
source iam-assume --retry role scratch.dev-full-access
set -euo pipefail

if ! aws sts get-caller-identity >/dev/null 2>&1; then
    echo "Could not assume scratch.dev-full-access. Aborting before any changes."
    exit 1
fi

sed -i "s|image: ContainerImage.fromRegistry(\"docker.n8n.io/n8nio/n8n:[^\"]*\")|image: ContainerImage.fromRegistry(\"docker.n8n.io/n8nio/n8n:$version\")|g" "$STACK_FILE"

npx cdk deploy --require-approval never --context environment=dev N8nDevN8NServiceStack
