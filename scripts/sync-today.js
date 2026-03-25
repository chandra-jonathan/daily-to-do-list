import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const {
  JIRA_BASE_URL,
  JIRA_EMAIL,
  JIRA_API_TOKEN,
  DEFAULT_PROJECT_KEY,
  DEFAULT_ASSIGNEE_EMAIL,
  TODAY_FILE = "planning/today.yaml"
} = process.env;

if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
  throw new Error("Missing Jira env config. Check .env values.");
}

const authHeader = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");

const jira = axios.create({
  baseURL: `${JIRA_BASE_URL}/rest/api/3`,
  headers: {
    Authorization: `Basic ${authHeader}`,
    Accept: "application/json",
    "Content-Type": "application/json"
  }
});

function mapPriority(bucket) {
  const value = String(bucket || "").toLowerCase();
  if (value === "high") return "High";
  if (value === "medium") return "Medium";
  return "Low";
}

function buildExternalKey(date, projectKey, title) {
  return `daily-sync:${date}:${projectKey}:${title}`.toLowerCase();
}

function toAdfParagraphs(lines) {
  return lines
    .filter(Boolean)
    .map((line) => ({
      type: "paragraph",
      content: [{ type: "text", text: line }]
    }));
}

async function lookupAccountIdByEmail(email) {
  if (!email) return null;

  const res = await jira.get("/user/search", {
    params: { query: email }
  });

  const users = Array.isArray(res.data) ? res.data : [];
  const exact = users.find(
    (x) => x.emailAddress === email || x.displayName === email
  );

  return exact?.accountId || users?.[0]?.accountId || null;
}

async function findExistingIssue(projectKey, externalKey) {
  const jql =
    `project = ${projectKey} ` +
    `AND labels = "daily-sync" ` +
    `AND text ~ "\\"${externalKey}\\"" ` +
    `ORDER BY created DESC`;

  const res = await jira.get("/search/jql", {
    params: {
      jql,
      maxResults: 1,
      fields: ["summary", "status"]
    }
  });

  return res.data?.issues?.[0] || null;
}

async function createIssue(task, date, assigneeAccountId) {
  const projectKey = task.projectKey || DEFAULT_PROJECT_KEY;
  const externalKey = buildExternalKey(date, projectKey, task.title);

  const descriptionLines = [
    task.description || "",
    `External Sync Key: ${externalKey}`,
    `Bucket: ${task.bucket || "Low"}`,
    `Sync Date: ${date}`
  ];

  const payload = {
    fields: {
      project: { key: projectKey },
      summary: task.title,
      issuetype: { name: task.issueType || "Task" },
      priority: { name: mapPriority(task.bucket) },
      labels: [...new Set(["daily-sync", ...(task.labels || [])])],
      description: {
        type: "doc",
        version: 1,
        content: toAdfParagraphs(descriptionLines)
      }
    }
  };

  if (assigneeAccountId) {
    payload.fields.assignee = { accountId: assigneeAccountId };
  }

  const res = await jira.post("/issue", payload);
  return res.data;
}

async function updateIssue(issueKey, task, date) {
  const projectKey = task.projectKey || DEFAULT_PROJECT_KEY;
  const externalKey = buildExternalKey(date, projectKey, task.title);

  const descriptionLines = [
    task.description || "",
    `External Sync Key: ${externalKey}`,
    `Bucket: ${task.bucket || "Low"}`,
    `Sync Date: ${date}`
  ];

  const payload = {
    fields: {
      summary: task.title,
      priority: { name: mapPriority(task.bucket) },
      labels: [...new Set(["daily-sync", ...(task.labels || [])])],
      description: {
        type: "doc",
        version: 1,
        content: toAdfParagraphs(descriptionLines)
      }
    }
  };

  await jira.put(`/issue/${issueKey}`, payload);
}

async function main() {
  const filePath = path.resolve(TODAY_FILE);
  const raw = fs.readFileSync(filePath, "utf8");
  const data = yaml.load(raw);

  if (!data?.date || !Array.isArray(data?.tasks)) {
    throw new Error("today.yaml must include 'date' and a 'tasks' array.");
  }

  const rootProjectKey = data.projectKey || DEFAULT_PROJECT_KEY;
  const assigneeAccountId = await lookupAccountIdByEmail(DEFAULT_ASSIGNEE_EMAIL);

  for (const task of data.tasks) {
    const projectKey = task.projectKey || rootProjectKey || DEFAULT_PROJECT_KEY;
    const externalKey = buildExternalKey(data.date, projectKey, task.title);

    const existing = await findExistingIssue(projectKey, externalKey);

    if (existing) {
      await updateIssue(existing.key, { ...task, projectKey }, data.date);
      console.log(`Updated ${existing.key} - ${task.title}`);
    } else {
      const created = await createIssue(
        { ...task, projectKey },
        data.date,
        assigneeAccountId
      );
      console.log(`Created ${created.key} - ${task.title}`);
    }
  }
}

main().catch((err) => {
  console.error("Sync failed.");
  console.error(err.response?.data || err.message);
  process.exit(1);
});
