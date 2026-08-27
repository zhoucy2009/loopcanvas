import assert from "node:assert/strict";
import test from "node:test";
import { githubRepositoryURL } from "../public/learning-reference.js";

test("探索来源中的 GitHub 仓库地址统一规范为仓库主页", () => {
  assert.equal(githubRepositoryURL("https://github.com/openai/openai-node"), "https://github.com/openai/openai-node");
  assert.equal(githubRepositoryURL("https://github.com/openai/openai-node.git/"), "https://github.com/openai/openai-node");
  assert.equal(githubRepositoryURL("https://github.com/openai/openai-node?tab=readme#readme"), "https://github.com/openai/openai-node");
});

test("GitHub 子页面和非公开仓库主页不会误触发自动导入", () => {
  for (const value of [
    "https://github.com/openai/openai-node/tree/main/src",
    "https://github.com/openai/openai-node/issues",
    "http://github.com/openai/openai-node",
    "https://user@github.com/openai/openai-node",
    "https://github.com:8443/openai/openai-node",
    "https://gitlab.com/openai/openai-node",
    "https://github.com/openai"
  ]) assert.equal(githubRepositoryURL(value), "", value);
});
