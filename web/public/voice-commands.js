const punctuationPattern = /^[\s，。！？、；：,.!?;:…]+|[\s，。！？、；：,.!?;:…]+$/g;

function compact(value) {
  return String(value ?? "").trim().replace(punctuationPattern, "").replace(/\s+/g, "");
}

function commandText(value) {
  return String(value ?? "").trim().replace(punctuationPattern, "").trim();
}

export function chineseNumber(value) {
  const source = compact(value).replace(/^第/, "").replace(/(?:个)?(?:步骤?|节点)$/, "");
  if (/^\d+$/.test(source)) return Number(source);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if ([...source].every((item) => Object.hasOwn(digits, item))) return Number([...source].map((item) => digits[item]).join(""));
  if (!source || !/^[零〇一二两三四五六七八九十百]+$/.test(source)) return null;
  let total = 0;
  let pending = 0;
  for (const item of source) {
    if (Object.hasOwn(digits, item)) pending = digits[item];
    else if (item === "十") { total += (pending || 1) * 10; pending = 0; }
    else if (item === "百") { total += (pending || 1) * 100; pending = 0; }
  }
  return total + pending || null;
}

export function parseVoiceCommand(transcript) {
  const spoken = commandText(transcript);
  const english = spoken.replace(/^hey[\s,!:]+/i, "").replace(/^please\s+/i, "");
  const command = (type, extra = {}) => ({ type, ...extra, transcript: spoken });
  if (/^(?:new|create(?: a)? new|open(?: a)? new) (?:task|request|project)$/i.test(english)) return command("new_request");
  if (/^gather(?: (?:agents|team))?$/i.test(english)) return command("gather");
  if (/^(?:plan|planner)(?: agent)?$/i.test(english)) return command("plan", { query: "", wakeAgent: "plan" });
  if (/^(?:execute|executor)(?: agent)?$/i.test(english)) return command("execute_step", { stepNumber: null, stepText: "", wakeAgent: "execute" });
  if (/^(?:review|reviewer)(?: agent)?$/i.test(english)) return command("step_review", { stepNumber: null, stepText: "", wakeAgent: "review" });
  if (/^(?:final review|review (?:the )?(?:project|deliverable))$/i.test(english)) return command("final_review");
  const numbered = english.match(/^(execute|run|review|check|roll back to|rollback to) step (\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)$/i);
  if (numbered) {
    const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
    const stepNumber = /^\d+$/.test(numbered[2]) ? Number(numbered[2]) : words.indexOf(numbered[2].toLowerCase());
    const type = /^(execute|run)$/i.test(numbered[1]) ? "execute_step" : /^(review|check)$/i.test(numbered[1]) ? "step_review" : "rollback";
    return command(type, { stepNumber, stepText: numbered[2] });
  }
  const query = english.match(/^(plan|search(?: for)?|learn(?: about)?|build|create)\s+(.+)$/i);
  if (query) return command(/^plan$/i.test(query[1]) ? "plan" : /^search/i.test(query[1]) ? "search" : /^learn/i.test(query[1]) ? "learning" : "workflow", { query: query[2].trim() });
  if (/^(?:open |show )?(?:live )?preview$/i.test(english)) return command("preview");
  if (/^(?:open )?(?:learn|learning)(?: mode)?$/i.test(english)) return command("learning", { query: "" });
  if (/^(?:open )?(?:workflow|execution)(?: mode)?$/i.test(english)) return command("workflow", { query: "" });
  if (/^pause(?: (?:task|and hand ?off))?$/i.test(english)) return command("pause");
  // Only a leading wake phrase is authoritative. Negations, quoted mentions and
  // words in the middle of a sentence must never wake a writing Agent.
  const prefixed = spoken.match(/^(?:hey|嘿|嗨)[\s，,。.!！?？:：、]*(?=(?:规划|执行|审核|集合|全体集合|精灵集合|开|新建|创建))([\s\S]+)$/i);
  if (prefixed) {
    const command = parseVoiceCommand(prefixed[1]);
    return { ...command, transcript: spoken };
  }
  const normalized = compact(spoken);
  if (!normalized) return { type: "unknown", transcript: spoken };
  if (/^(?:请|帮我)?(?:开|打开|新建|创建)(?:一个|个)?新需求$/.test(normalized) || normalized === "新建需求") return { type: "new_request", transcript: spoken };
  if (/^(?:请)?(?:集合|全体集合|精灵集合)$/.test(normalized)) return { type: "gather", transcript: spoken };

  const wake = normalized.match(/^(规划|执行|审核)(?:agent|智能体)?$/i);
  if (wake) {
    if (wake[1] === "规划") return { type: "plan", query: "", wakeAgent: "plan", transcript: spoken };
    if (wake[1] === "执行") return { type: "execute_step", stepNumber: null, stepText: "", wakeAgent: "execute", transcript: spoken };
    return { type: "step_review", stepNumber: null, stepText: "", wakeAgent: "review", transcript: spoken };
  }

  let match = normalized.match(/^(?:请|麻烦)?(?:帮我)?(?:做|进行|开始)?(?:一次)?(?:最终|终局|交付前)(?:审核|审查|检查|验收|裁决)(?:一下|一遍)?$/);
  if (match) return { type: "final_review", transcript: spoken };
  if (/^(?:请|麻烦)?(?:帮我)?(?:对)?(?:整个|全部)?(?:成品|成果|项目|交付物)(?:做|进行)?(?:一下|一次)?(?:最后|最终)(?:审核|审查|检查|验收|裁决)$/.test(normalized)) return { type: "final_review", transcript: spoken };

  match = normalized.match(/^(?:请|麻烦)?(?:帮我)?(?:审核|审查|检查|验收)(?:一下|一遍)?(?:第(.+?)(?:步|个步骤|步骤|个节点|节点)(?:的)?(?:结果)?)?$/);
  if (match) return { type: "step_review", stepNumber: match[1] ? chineseNumber(match[1]) : null, stepText: match[1] ?? "", transcript: spoken };
  if (/^(?:请|麻烦)?(?:帮我)?(?:把)?(?:刚刚|刚才)?(?:这个|当前)?(?:的)?(?:结果|步骤|节点)?(?:把把关|看一看|看看)(?:做得)?(?:对不对|怎么样)?$/.test(normalized)) return { type: "step_review", stepNumber: null, stepText: "", transcript: spoken };

  match = normalized.match(/^(?:请|麻烦)?(?:帮我)?(?:执行|运行|开始执行|开始运行|做)(?:一下)?第(.+?)(?:步|个步骤|步骤|个节点|节点)$/);
  if (match) return { type: "execute_step", stepNumber: chineseNumber(match[1]), stepText: match[1], transcript: spoken };
  match = normalized.match(/^(?:请|麻烦)?(?:从)?第(.+?)(?:步|个步骤|步骤|个节点|节点)(?:开始)?(?:执行|运行|做|干)$/);
  if (match) return { type: "execute_step", stepNumber: chineseNumber(match[1]), stepText: match[1], transcript: spoken };

  match = normalized.match(/^(?:请|麻烦)?(?:帮我)?(?:策划|规划|计划|设计方案)(?:一下)?(.*)$/);
  if (match) {
    const query = commandText(spoken.replace(/^(?:请\s*|麻烦\s*)?(?:帮我\s*)?(?:策划|规划|计划|设计方案)(?:一下)?[\s，,：:]*/, ""));
    return { type: "plan", query, transcript: spoken };
  }
  match = normalized.match(/^(?:请|麻烦)?(?:给我)?(?:先)?(?:列|出|想|做)(?:一个|个)?(?:落地|实施|执行)?(?:方案|计划|路线)(.*)$/);
  if (match) return { type: "plan", query: commandText(match[1]), transcript: spoken };

  match = normalized.match(/^(?:请|麻烦)?(?:帮我)?(?:搜|搜索|查一下|查找)(?:一下)?(.+)$/);
  if (match) return { type: "search", query: commandText(spoken.replace(/^(?:请\s*|麻烦\s*)?(?:帮我\s*)?(?:搜索|搜|查一下|查找)(?:一下)?[\s，,：:]*/, "")), transcript: spoken };

  match = normalized.match(/^(?:我)?(?:需要|想要|想)?(?:学习|学)(?:一下)?(.+)$/);
  if (match) return { type: "learning", query: commandText(spoken.replace(/^(?:我\s*)?(?:需要|想要|想)?\s*(?:学习|学)(?:一下)?[\s，,：:]*/, "")), transcript: spoken };
  if (/^(?:进入|打开|切换到)?学习(?:模式)?$/.test(normalized)) return { type: "learning", query: "", transcript: spoken };

  match = normalized.match(/^(?:我)?(?:想|要|需要)(?:做|制作|创建|实现)(?:一个|个)?(.+)$/);
  if (match) return { type: "workflow", query: commandText(spoken.replace(/^(?:我\s*)?(?:想|要|需要)\s*(?:做|制作|创建|实现)(?:一个|个)?[\s，,：:]*/, "")), transcript: spoken };
  if (/^(?:进入|打开|切换到)?执行(?:模式)?$/.test(normalized)) return { type: "workflow", query: "", transcript: spoken };

  match = normalized.match(/^回退到第(.+?)(?:步|个步骤|步骤|个节点|节点)$/);
  if (match) return { type: "rollback", stepNumber: chineseNumber(match[1]), stepText: match[1], transcript: spoken };

  if (/^(?:我)?(?:想)?看看现在(?:的)?效果$/.test(normalized) || /^(?:打开|进入)(?:演示|预览)(?:窗口)?$/.test(normalized)) {
    return { type: "preview", transcript: spoken };
  }

  if (/^(?:请)?暂停(?:任务)?并交接$/.test(normalized) || /^暂停任务并交接$/.test(normalized)) {
    return { type: "pause", transcript: spoken };
  }

  return { type: "unknown", transcript: spoken };
}

export function voiceLocalOperationLabel(type) {
  if (type === "rollback") return "Git worktree · 恢复本机文件与工作流";
  if (type === "pause") return "无 · 仅暂停/生成交接状态";
  return "";
}

export const voiceCommandExamples = [
  "规划", "hey，执行", "hey，审核",
  "帮我策划 这个需求",
  "执行第三步",
  "审核一下",
  "最终审核一下",
  "帮我搜 本地优先的前端框架",
  "我需要学 状态管理",
  "我想做一个 项目看板",
  "回退到第三步",
  "我看看现在的效果",
  "暂停任务并交接"
];
