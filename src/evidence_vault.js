// 证据封存库：安全投诉所需证据“另行封存”，与普通联系数据物理隔离。
//
// 承诺：
// - 证据只能用于受理时写明的目的（投诉调查/法定配合），读取必须登记；
// - 证据内容不回传给投诉发起人，跨品牌申诉接口不暴露其他儿童资料；
// - 每条证据含封存截止时间，到期必须销毁（purgeExpired）；
// - 哈希链让任何事后增删都可被发现。

import { createHash } from "node:crypto";
import { DURATIONS_MS } from "./policy.js";

const PURPOSES = new Set(["COMPLAINT_INVESTIGATION", "LEGAL_REQUEST"]);

export class EvidenceVault {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this._items = new Map(); // evidenceId -> sealed record（含销毁时间）
    this._accessLog = [];
    this._chainHead = "GENESIS";
  }

  _link(evidenceId, fingerprint) {
    this._chainHead = createHash("sha256").update(`${this._chainHead}|${evidenceId}|${fingerprint}`).digest("hex");
    return this._chainHead;
  }

  // 封存：content 为任意证据对象；只保存调用方提供的最小必要材料。
  seal({ complaintRef, brandId, content, purpose = "COMPLAINT_INVESTIGATION", retainForMs = DURATIONS_MS.EVIDENCE_RETENTION }) {
    if (!complaintRef) throw new Error("evidence.seal 需要 complaintRef");
    if (!PURPOSES.has(purpose)) throw new Error(`evidence.seal 目的不被允许: ${purpose}`);
    const sealedAt = this.now();
    const evidenceId = `ev-${Math.abs(hash(`${complaintRef}|${brandId}|${sealedAt}|${JSON.stringify(content)}`)).toString(16).slice(0, 12)}`;
    const fingerprint = hash(JSON.stringify(content));
    const chainHash = this._link(evidenceId, fingerprint);
    const record = Object.freeze({
      evidenceId,
      complaintRef,
      brandId,
      purpose,
      sealedAt,
      purgeAt: sealedAt + retainForMs,
      fingerprint,
      chainHash,
      content: deepFreeze(structuredClone(content)),
    });
    this._items.set(evidenceId, record);
    return { evidenceId, fingerprint, purgeAt: record.purgeAt, chainHash };
  }

  // 目的限制的读取：访问方、目的必须与封存目的匹配，且全程登记。
  get(evidenceId, { brandId, purpose, actor }) {
    const record = this._items.get(evidenceId);
    if (!record) {
      this._audit(evidenceId, brandId, purpose, actor, false);
      return null;
    }
    const allowed = record.purpose === purpose && (purpose === "LEGAL_REQUEST" || record.brandId === brandId);
    this._audit(evidenceId, brandId, purpose, actor, allowed);
    if (!allowed) return null;
    return record;
  }

  _audit(evidenceId, brandId, purpose, actor, allowed) {
    this._accessLog.push(Object.freeze({ at: this.now(), evidenceId, brandId, purpose, actor: actor ?? null, allowed }));
  }

  accessLog() {
    return [...this._accessLog];
  }

  listForComplaint(complaintRef) {
    // 只返回元数据，不含内容——用于跨品牌协作而不扩散证据。
    return [...this._items.values()]
      .filter((r) => r.complaintRef === complaintRef)
      .map(({ content, ...meta }) => meta);
  }

  // 到期销毁：返回被销毁的 evidenceId 列表。
  purgeExpired() {
    const purged = [];
    for (const [id, record] of this._items) {
      if (this.now() >= record.purgeAt) {
        this._items.delete(id);
        purged.push(id);
      }
    }
    return purged;
  }

  get chainHead() {
    return this._chainHead;
  }
}

function hash(text) {
  return createHash("sha256").update(text).digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}
