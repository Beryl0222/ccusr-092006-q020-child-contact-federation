// 事件日志与证据封存。
//
// 两条链严格分开：
//  1) EventLog —— 业务事件流，哈希链只追加，用于审计与重放，参与撤销/缓存失效；
//  2) EvidenceVault —— 安全投诉证据另行封存：独立保留期（365 天）、访问登记，
//     业务接口（路由投影、解释卡片、申诉信封）只能拿到引用哈希，拿不到内容。
//
// 参考实现使用内存存储；生产环境应替换为只追加存储（WORM）并把链头定期发布到
// 联盟见证处。接口保持不变。

import { createHash } from "node:crypto";
import { DEADLINES } from "./policy.js";

// 递归稳定序列化：对象键排序后再哈希，嵌套层级一视同仁，任何字段被改都会改变摘要。
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

function digest(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export class EventLog {
  constructor() {
    this.events = [];
  }

  append(kind, subjectId, payload = {}) {
    const prevHash = this.events.length ? this.events.at(-1).hash : "GENESIS";
    const body = {
      event_id: `evt_${this.events.length + 1}_${digest({ kind, subjectId, payload, nonce: this.events.length }).slice(0, 10)}`,
      kind,
      occurred_at: payload.__at ?? new Date().toISOString(),
      subject_id: subjectId,
      payload,
      prev_hash: prevHash,
    };
    delete body.payload.__at;
    const event = { ...body, hash: digest(body) };
    this.events.push(event);
    return event;
  }

  // 校验哈希链；任何条目被改写都会导致后续全部失配。
  verify() {
    let prev = "GENESIS";
    for (const event of this.events) {
      if (event.prev_hash !== prev) return false;
      const { hash, ...body } = event;
      if (digest(body) !== hash) return false;
      prev = hash;
    }
    return true;
  }

  bySubject(subjectId) {
    return this.events.filter((e) => e.subject_id === subjectId);
  }

  // 重放辅助：取出某主体的全部状态变更事件（不含解释/去重等噪音）。
  stateEvents(subjectId) {
    const noise = new Set(["DECISION_LOGGED", "COMMAND_DEDUPLICATED"]);
    return this.bySubject(subjectId).filter((e) => !noise.has(e.kind));
  }
}

export class EvidenceVault {
  constructor(now = () => new Date()) {
    this.now = now;
    this.bundles = new Map();  // ref -> sealed bundle
    this.accessLog = [];
  }

  // 封存一份投诉证据。返回引用；引用本身不含任何儿童资料，可进申诉信封。
  seal({ reporterId, relationshipId, category, facts, attachments = [] }) {
    const content = { reporterId, relationshipId, category, facts, attachments };
    const ref = `ev_${digest(content).slice(0, 24)}`;
    if (this.bundles.has(ref)) return ref; // 同样内容幂等封存，不产生多份
    const sealedAt = this.now().toISOString();
    this.bundles.set(ref, {
      ref,
      sealed_at: sealedAt,
      retains_until: new Date(this.now().getTime() + DEADLINES.EVIDENCE_RETENTION_DAYS * 864e5).toISOString(),
      content_hash: digest(content),
      content,                       // 生产中应为加密静态存储，读取需双人审批
      access: [],
    });
    return ref;
  }

  // 读取必须登记目的与调用人；业务流永远不调用此方法。
  open(ref, { accessedBy, purpose }) {
    const bundle = this.bundles.get(ref);
    if (!bundle) return null;
    const entry = { ref, accessedBy, purpose, at: this.now().toISOString() };
    bundle.access.push(entry);
    this.accessLog.push(entry);
    return { ...bundle.content, content_hash: bundle.content_hash };
  }

  purgeExpired() {
    for (const [ref, bundle] of this.bundles) {
      if (new Date(bundle.retains_until) <= this.now()) this.bundles.delete(ref);
    }
  }

  // 给审计/监管的清单：只有元数据，不含内容。
  manifest() {
    return [...this.bundles.values()].map((b) => ({
      ref: b.ref,
      sealed_at: b.sealed_at,
      retains_until: b.retains_until,
      content_hash: b.content_hash,
      access_count: b.access.length,
    }));
  }
}
