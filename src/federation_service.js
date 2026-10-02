// 儿童联系人跨品牌互通服务。
//
// 设计要点（对应家长与监管诉求）：
// 1. 窄通路：跨品牌联系人只暴露 MINIMAL_CONTACT_FIELDS；没有陌生人搜索接口，
//    建立关系必须先核销一次性“相识凭证”（面对面短码/学校证明/监护人引荐）。
// 2. 四重门：双方儿童确认 + 双方监护人同意，全部在 7 天期限内完成，关系才成立。
// 3. 能力随龄：按双方年龄段交集开放文字/语音/群组；位置只有逐次限时会话。
// 4. 幂等：加友请求带幂等键；离线手表重发返回同一关系，绝不产生第二条。
// 5. 可撤销：撤销后下发缓存失效指令，承诺 24 小时内失效，逐品牌收回执。
// 6. 连续路径：设备换绑、监护权改变、账号迁移、品牌退出、紧急例外都有
//    明确的状态、期限与恢复/终止出口。
// 7. 可解释：每个允许/阻断都给出家长可读的中文理由与剩余期限。
// 8. 证据另封：投诉证据进入目的受限的 EvidenceVault，不进入联系人数据流。

import { randomInt } from "node:crypto";
import {
  CAPABILITIES,
  COMPLAINT_CATEGORIES,
  INTRO_KINDS,
  MINIMAL_CONTACT_FIELDS,
  REASON_CODES,
  findExcessiveFields,
} from "./domain.js";
import { DURATIONS_MS, REASON_TEXT, isExpired, sharedCapabilities } from "./policy.js";
import { EvidenceVault } from "./evidence_vault.js";

export class FederationDecisionError extends Error {
  constructor(decision) {
    super(decision.reasons.map((r) => r.text).join("；") || "互通请求被拒绝");
    this.name = "FederationDecisionError";
    this.decision = decision;
  }
}

export class ChildContactFederation {
  constructor({ now = () => Date.now(), vault = new EvidenceVault({ now }) } = {}) {
    this.now = now;
    this.vault = vault;
    this._brands = new Map(); // brandId -> { brandId, status, exit?: {declaredAt, deadline} }
    this._children = new Map(); // childId -> { childId, brandId, ageBand, guardianIds:Set, pseudonym, displayLabel }
    this._relationships = new Map(); // relId -> relationship
    this._pairIndex = new Map(); // "a↔b" -> relId（仅非终态关系占用）
    this._proofs = new Map(); // code -> intro proof
    this._rebinds = new Map(); // childId -> { startedAt, deadline, completedAt, canceledAt }
    this._guardianship = new Map(); // childId -> { startedAt, deadline, reaffirmedAt }
    this._migration = new Map(); // childId -> { startedAt, deadline, fromBrand, toBrand }
    this._complaints = new Map(); // complaintRef -> complaint
    this._idempotency = new Map(); // idempotencyKey -> relId
    this._events = [];
    this._seq = 0;
  }

  // ---------- 目录与账号 ----------

  enrollBrand(brandId) {
    if (!this._brands.has(brandId)) {
      this._brands.set(brandId, { brandId, status: "ACTIVE" });
    }
    return this._brands.get(brandId);
  }

  enrollChild({ childId, brandId, ageBand, guardianIds, displayLabel = null }) {
    if (!this._brands.get(brandId)) throw new Error(`品牌 ${brandId} 未加入联盟`);
    if (!guardianIds || guardianIds.length === 0) throw new Error("儿童账号必须至少绑定一位监护人");
    if (this._children.has(childId)) throw new Error(`儿童账号 ${childId} 已存在`);
    const child = {
      childId,
      brandId,
      ageBand,
      guardianIds: new Set(guardianIds),
      pseudonym: `pseudo-${(++this._seq).toString(36)}-${randomInt(1e5, 1e6).toString(36)}`,
      displayLabel,
    };
    this._children.set(childId, child);
    this._emit("GUARDIAN_LINKED", childId, { brandId, guardian_ids: [...guardianIds] });
    return this._publicChildView(child);
  }

  // ---------- 一次性相识凭证 ----------

  // 面对面短码由现场监护人在两台设备旁生成；学校证明由学校账号签发；
  // 监护人引荐由一方监护人发起。三类凭证都只负责“一次相识”，均有有效期。
  issueIntroProof({ kind, childIdA, childIdB, issuedBy }) {
    if (!INTRO_KINDS.includes(kind)) throw new Error(`未知相识方式: ${kind}`);
    const a = this._requireChild(childIdA);
    const b = this._requireChild(childIdB);
    if (a.childId === b.childId) throw new Error("相识凭证必须对应两个不同的孩子");
    if (kind === "FACE_TO_FACE_SHORT_CODE" && !issuedBy?.guardianId) {
      throw new Error("面对面短码必须由一位在场监护人签发");
    }
    if (kind === "SCHOOL_ATTESTATION" && !issuedBy?.schoolId) {
      throw new Error("学校证明必须由学校账号签发");
    }
    if (kind === "GUARDIAN_REFERENCE" && !issuedBy?.guardianId) {
      throw new Error("监护人引荐必须由监护人签发");
    }
    const ttl = {
      FACE_TO_FACE_SHORT_CODE: DURATIONS_MS.INTRO_FACE_TO_FACE_SHORT_CODE,
      SCHOOL_ATTESTATION: DURATIONS_MS.INTRO_SCHOOL_ATTESTATION,
      GUARDIAN_REFERENCE: DURATIONS_MS.INTRO_GUARDIAN_REFERENCE,
    }[kind];
    const issuedAt = this.now();
    const code = kind === "FACE_TO_FACE_SHORT_CODE" ? String(randomInt(100000, 1000000)) : `intro-${(++this._seq).toString(36)}`;
    const proof = Object.freeze({
      introRef: `ref-${(++this._seq).toString(36)}`,
      code,
      kind,
      pair: [childIdA, childIdB].sort(),
      issuedBy: structuredClone(issuedBy),
      issuedAt,
      expiresAt: issuedAt + ttl,
      redeemedAt: null,
      redeemedByRequest: null,
    });
    this._proofs.set(code, proof);
    this._emit("INTRO_PROOF_ISSUED", childIdA, {
      intro_ref: proof.introRef,
      kind,
      expires_at: new Date(proof.expiresAt).toISOString(),
    });
    return { code: proof.code, introRef: proof.introRef, expiresAt: proof.expiresAt };
  }

  // ---------- 加友请求（幂等） ----------

  // 返回决策对象而非抛错：允许与阻断都走同一结构，调用方直接展示给家长。
  requestFriend({ fromChildId, introCode, idempotencyKey }) {
    // 离线手表重发：同一幂等键永远返回同一关系，不做第二次核销、不建第二条关系。
    if (idempotencyKey && this._idempotency.has(idempotencyKey)) {
      const rel = this._relationships.get(this._idempotency.get(idempotencyKey));
      return this._requestView(rel, "DUPLICATE_RESEND");
    }
    const child = this._children.get(fromChildId);
    if (!child) return this._deny(REASON_CODES.BRAND_NOT_IN_FEDERATION); // 未知账号按未入盟处理，不泄露存在性

    const proof = this._proofs.get(introCode);
    if (!proof || !proof.pair.includes(fromChildId)) return this._deny(REASON_CODES.INTRO_REQUIRED);
    if (proof.redeemedAt) return this._deny(REASON_CODES.INTRO_ALREADY_USED);
    if (isExpired(proof.expiresAt, this.now())) return this._deny(REASON_CODES.INTRO_EXPIRED);

    const counterpartId = proof.pair.find((id) => id !== fromChildId);
    const counterpart = this._requireChild(counterpartId);

    const brandDecision = this._brandGate(child.brandId, counterpart.brandId);
    if (brandDecision) return brandDecision;

    const pairKey = this._pairKey(fromChildId, counterpartId);
    if (this._pairIndex.has(pairKey)) {
      return this._requestView(this._relationships.get(this._pairIndex.get(pairKey)), "ALREADY_PENDING_OR_ACTIVE");
    }

    const issuedAt = this.now();
    const rel = {
      id: `rel-${++this._seq}`,
      pair: [fromChildId, counterpartId],
      introRef: proof.introRef,
      introKind: proof.kind,
      state: "PENDING",
      createdAt: issuedAt,
      requestDeadline: issuedAt + DURATIONS_MS.FRIEND_REQUEST_TTL,
      confirmed: { [fromChildId]: false, [counterpartId]: false },
      guardianDecisions: new Map(), // guardianId -> true/false
      activeAt: null,
      grantedCapabilities: [],
      locationSessions: [],
      complaintRefs: [],
      cacheDirectives: [],
      emergency: null,
      terminalReason: null,
      suspension: null, // {code, complaintRef?}
    };
    this._relationships.set(rel.id, rel);
    this._pairIndex.set(pairKey, rel.id);
    if (idempotencyKey) this._idempotency.set(idempotencyKey, rel.id);

    this._proofs.set(introCode, { ...proof, redeemedAt: issuedAt, redeemedByRequest: rel.id });
    this._emit("INTRO_PROOF_REDEEMED", fromChildId, { intro_ref: proof.introRef, relationship_id: rel.id });
    this._emit("FRIEND_REQUESTED", fromChildId, {
      relationship_id: rel.id,
      counterpart_pseudonym: counterpart.pseudonym,
      expires_at: new Date(rel.requestDeadline).toISOString(),
    });
    return this._requestView(rel, "CREATED");
  }

  childConfirm({ relationshipId, childId }) {
    const rel = this._requireRel(relationshipId);
    this._sweepRelationship(rel);
    if (rel.state !== "PENDING") return this.explain(relationshipId);
    if (isExpired(rel.requestDeadline, this.now())) {
      this._terminate(rel, REASON_CODES.REQUEST_EXPIRED);
      return this.explain(relationshipId);
    }
    if (!(childId in rel.confirmed)) throw new Error("只有关系双方可以确认");
    rel.confirmed[childId] = true;
    this._emit("CHILD_CONFIRMED", childId, { relationship_id: rel.id });
    this._maybeActivate(rel);
    return this.explain(relationshipId);
  }

  // 监护人同意 / 撤回。撤回对已成立关系立即生效（撤销路径）。
  guardianConsent({ relationshipId, guardianId, decision = true }) {
    const rel = this._requireRel(relationshipId);
    this._sweepRelationship(rel);
    const side = this._sideOfGuardian(rel, guardianId);
    if (!side) throw new Error("只有关系双方的监护人可以表态");
    rel.guardianDecisions.set(guardianId, decision);
    this._emit(decision ? "GUARDIAN_CONSENTED" : "GUARDIAN_CONSENT_WITHDRAWN", side, {
      relationship_id: rel.id,
    });
    if (!decision && rel.state === "ACTIVE") {
      this._revoke(rel, REASON_CODES.GUARDIAN_CONSENT_WITHDRAWN, { by_guardian: guardianId });
    } else if (rel.state === "PENDING") {
      this._maybeActivate(rel);
    }
    return this.explain(relationshipId);
  }

  _maybeActivate(rel) {
    if (rel.state !== "PENDING") return;
    const bothConfirmed = rel.pair.every((id) => rel.confirmed[id]);
    const bothConsented = rel.pair.every((id) => this._sideConsented(rel, id));
    if (!(bothConfirmed && bothConsented)) return;
    if (isExpired(rel.requestDeadline, this.now())) {
      this._terminate(rel, REASON_CODES.REQUEST_EXPIRED);
      return;
    }
    rel.state = "ACTIVE";
    rel.suspension = null;
    rel.activeAt = this.now();
    const [a, b] = rel.pair.map((id) => this._children.get(id));
    rel.grantedCapabilities = sharedCapabilities(a.ageBand, b.ageBand);
    this._emit("CONTACT_CONFIRMED", rel.pair[0], {
      relationship_id: rel.id,
      granted_capabilities: rel.grantedCapabilities,
    });
    this._emit("CAPABILITY_GRANTED", rel.pair[0], {
      relationship_id: rel.id,
      granted_capabilities: rel.grantedCapabilities,
    });
  }

  _sideConsented(rel, childId) {
    const child = this._children.get(childId);
    let any = false;
    for (const [guardianId, ok] of rel.guardianDecisions) {
      if (child.guardianIds.has(guardianId) && ok) any = true;
      if (child.guardianIds.has(guardianId) && !ok) return false; // 任一现任监护人撤回即否决
    }
    return any;
  }

  _sideOfGuardian(rel, guardianId) {
    for (const id of rel.pair) {
      if (this._children.get(id)?.guardianIds.has(guardianId)) return id;
    }
    return null;
  }

  // ---------- 能力门：文字 / 语音 / 群组 / 位置（逐次限时） ----------

  canUseCapability({ relationshipId, childId, capability }) {
    if (!CAPABILITIES.includes(capability)) throw new Error(`未知能力: ${capability}`);
    const rel = this._requireRel(relationshipId);
    this._sweepRelationship(rel);
    if (rel.state === "SUSPENDED") this._resumeIfClear(rel);

    if (rel.state === "EMERGENCY_LIMITED") {
      if (["TEXT", "VOICE"].includes(capability) && this.now() < rel.emergency.endsAt) {
        return this._allow(`紧急通道：${REASON_TEXT[REASON_CODES.EMERGENCY_ONLY]}`);
      }
      return this._deny(this.now() >= rel.emergency.endsAt ? REASON_CODES.EMERGENCY_EXPIRED : REASON_CODES.EMERGENCY_ONLY);
    }
    if (rel.state === "REVOKED") return this._deny(REASON_CODES.RELATIONSHIP_REVOKED);
    if (rel.state === "TERMINATED") return this._deny(rel.terminalReason ?? REASON_CODES.RELATIONSHIP_REVOKED);
    if (rel.state === "SUSPENDED") return this._deny(rel.suspension?.code ?? REASON_CODES.COMPLAINT_UNDER_REVIEW);
    if (rel.state === "PENDING") {
      if (!rel.pair.every((id) => rel.confirmed[id])) return this._deny(REASON_CODES.PEER_CONFIRMATION_REQUIRED);
      return this._deny(REASON_CODES.GUARDIAN_CONSENT_REQUIRED);
    }

    const rebindingChild = rel.pair.find((id) => {
      const rb = this._rebinds.get(id);
      return rb && !rb.completedAt && !rb.canceledAt && this.now() <= rb.deadline;
    });
    if (rebindingChild) return this._deny(REASON_CODES.DEVICE_REBIND_PENDING);
    if (!rel.grantedCapabilities.includes(capability)) {
      return this._deny(REASON_CODES.AGE_GATE_BLOCKED, { capability });
    }
    if (capability === "LOCATION") {
      const open = rel.locationSessions.find((s) => !s.closed && this.now() < s.endsAt && s.childId === childId);
      if (!open) return this._deny(REASON_CODES.LOCATION_SESSION_REQUIRED);
      return this._allow(`位置分享限时会话进行中，将于 ${new Date(open.endsAt).toISOString()} 自动关闭`);
    }
    return this._allow(`双方年龄段均允许“${capabilityName(capability)}”，且关系有效`);
  }

  // 位置没有长期授权：每次分享都要开一个有上限的会话，到期自动关闭。
  startLocationSession({ relationshipId, childId, ttlMs }) {
    const rel = this._requireRel(relationshipId);
    this._sweepRelationship(rel);
    if (rel.state !== "ACTIVE") return this.explain(relationshipId);
    const rebinding = rel.pair.some((id) => {
      const rb = this._rebinds.get(id);
      return rb && !rb.completedAt && !rb.canceledAt && this.now() <= rb.deadline;
    });
    if (rebinding) return this._deny(REASON_CODES.DEVICE_REBIND_PENDING);
    if (!rel.grantedCapabilities.includes("LOCATION")) return this._deny(REASON_CODES.AGE_GATE_BLOCKED, { capability: "LOCATION" });
    const ttl = Math.min(ttlMs ?? DURATIONS_MS.LOCATION_SESSION_DEFAULT, DURATIONS_MS.LOCATION_SESSION_TTL);
    const startedAt = this.now();
    const session = { id: `loc-${++this._seq}`, childId, startedAt, endsAt: startedAt + ttl, closed: false };
    rel.locationSessions.push(session);
    this._emit("LOCATION_SESSION_GRANTED", childId, {
      relationship_id: rel.id,
      session_id: session.id,
      ends_at: new Date(session.endsAt).toISOString(),
    });
    return { sessionId: session.id, endsAt: session.endsAt, decision: this._allow("位置分享限时会话已开启") };
  }

  closeLocationSession({ relationshipId, sessionId }) {
    const rel = this._requireRel(relationshipId);
    const session = rel.locationSessions.find((s) => s.id === sessionId);
    if (!session) throw new Error("未知位置会话");
    session.closed = true;
    this._emit("LOCATION_SESSION_CLOSED", session.childId, { relationship_id: rel.id, session_id: sessionId });
    return this.explain(relationshipId);
  }

  // ---------- 撤销与缓存失效承诺 ----------

  revokeRelationship({ relationshipId, guardianId, reasonCode = REASON_CODES.RELATIONSHIP_REVOKED }) {
    const rel = this._requireRel(relationshipId);
    if (guardianId && !this._sideOfGuardian(rel, guardianId)) throw new Error("只有关系双方监护人可以撤销");
    if (rel.state === "REVOKED" || rel.state === "TERMINATED") return this.explain(relationshipId);
    this._revoke(rel, reasonCode, { by_guardian: guardianId ?? null });
    return this.explain(relationshipId);
  }

  _revoke(rel, reasonCode, extra = {}) {
    rel.state = "REVOKED";
    rel.suspension = null;
    rel.terminalReason = reasonCode;
    rel.revokedAt = this.now();
    this._pairIndex.delete(this._pairKey(rel.pair[0], rel.pair[1]));
    this._emit("RELATIONSHIP_REVOKED", rel.pair[0], {
      relationship_id: rel.id,
      reason_code: reasonCode,
      ...extra,
    });
    this._issueCacheDirective(rel, "REVOCATION");
  }

  _terminate(rel, reasonCode, extra = {}) {
    rel.state = "TERMINATED";
    rel.suspension = null;
    rel.terminalReason = reasonCode;
    rel.terminatedAt = this.now();
    this._pairIndex.delete(this._pairKey(rel.pair[0], rel.pair[1]));
    this._emit("RELATIONSHIP_REVOKED", rel.pair[0], {
      relationship_id: rel.id,
      reason_code: reasonCode,
      ...extra,
    });
    this._issueCacheDirective(rel, "TERMINATION");
  }

  _issueCacheDirective(rel, type, extra = {}, brandsOverride = null) {
    const brands = brandsOverride
      ?? (rel.emergency ? [this._children.get(rel.pair[0])?.brandId, rel.emergency.remote.brand_id] : rel.pair.map((id) => this._children.get(id)?.brandId));
    const directive = {
      id: `cache-${++this._seq}`,
      type,
      issuedAt: this.now(),
      deadline: this.now() + DURATIONS_MS.CACHE_EXPIRY_AFTER_REVOCATION,
      brands: [...new Set(brands.filter(Boolean))],
      acks: new Set(),
      overdue: false,
      ...extra,
    };
    rel.cacheDirectives.push(directive);
    return directive;
  }

  // 各方按承诺时间失效本地缓存后回执。未按时回执会被治理视图标为逾期，不会被默认成已失效。
  ackCacheInvalidation({ relationshipId, directiveId, brandId }) {
    const rel = this._requireRel(relationshipId);
    const directive = rel.cacheDirectives.find((d) => d.id === directiveId) ?? rel.cacheDirectives.at(-1);
    if (!directive) throw new Error("没有待回执的缓存失效指令");
    if (!directive.brands.includes(brandId)) throw new Error("该品牌不在此缓存失效指令的对象范围内");
    directive.acks.add(brandId);
    this._emit("CACHE_INVALIDATION_ACK", rel.pair[0], {
      relationship_id: rel.id,
      directive_id: directive.id,
      brand_id: brandId,
    });
    return this.cacheStatus(relationshipId);
  }

  cacheStatus(relationshipId) {
    const rel = this._requireRel(relationshipId);
    return rel.cacheDirectives.map((d) => ({
      directiveId: d.id,
      type: d.type,
      deadline: d.deadline,
      promisedInvalidBy: d.deadline,
      pendingBrands: d.brands.filter((b) => !d.acks.has(b)),
      acknowledgedBy: [...d.acks],
      overdue: d.overdue || (this.now() > d.deadline && d.acks.size < d.brands.length),
    }));
  }

  // ---------- 设备换绑：明确期限，关系不删除 ----------

  startDeviceRebind({ childId, newDeviceRef, requestedByGuardianId }) {
    const child = this._requireChild(childId);
    if (!child.guardianIds.has(requestedByGuardianId)) throw new Error("必须由孩子的监护人发起换绑");
    const startedAt = this.now();
    this._rebinds.set(childId, { startedAt, deadline: startedAt + DURATIONS_MS.DEVICE_REBIND_TTL, completedAt: null, canceledAt: null, newDeviceRef });
    for (const rel of this._relationshipsOf(childId)) {
      if (rel.state === "ACTIVE") this._suspend(rel, REASON_CODES.DEVICE_REBIND_PENDING);
    }
    this._emit("DEVICE_REBIND_STARTED", childId, {
      expires_at: new Date(startedAt + DURATIONS_MS.DEVICE_REBIND_TTL).toISOString(),
    });
    return { deadline: startedAt + DURATIONS_MS.DEVICE_REBIND_TTL };
  }

  completeDeviceRebind({ childId, newDeviceRef }) {
    const rb = this._rebinds.get(childId);
    if (!rb || rb.completedAt || rb.canceledAt) throw new Error("没有进行中的换绑");
    rb.completedAt = this.now();
    this._emit("DEVICE_REBIND_COMPLETED", childId, { new_device_ref: newDeviceRef ?? rb.newDeviceRef });
    for (const rel of this._relationshipsOf(childId)) this._resumeIfClear(rel);
    return { completedAt: rb.completedAt };
  }

  // ---------- 监护权改变：30 天宽限的连续路径 ----------

  startGuardianshipTransfer({ childId, newGuardianIds, requestedByGuardianId }) {
    const child = this._requireChild(childId);
    if (!child.guardianIds.has(requestedByGuardianId)) throw new Error("监护权变更须由现任监护人发起");
    if (!newGuardianIds?.length) throw new Error("必须指定新监护人");
    const startedAt = this.now();
    const previousGuardianIds = new Set(child.guardianIds);
    child.guardianIds = new Set(newGuardianIds);
    this._guardianship.set(childId, { startedAt, deadline: startedAt + DURATIONS_MS.GUARDIANSHIP_GRACE });
    for (const rel of this._relationshipsOf(childId)) {
      if (rel.state === "ACTIVE" || rel.state === "SUSPENDED") {
        // 只清掉变更方旧监护人的表态；对方监护人的同意不因其监护权变化而失效。
        for (const guardianId of previousGuardianIds) rel.guardianDecisions.delete(guardianId);
        rel.guardianship = { childId, reaffirmedAt: null };
        this._suspend(rel, REASON_CODES.GUARDIANSHIP_GRACE_PENDING);
      }
    }
    this._emit("GUARDIANSHIP_TRANSFER_STARTED", childId, {
      new_guardian_ids: newGuardianIds,
      grace_ends_at: new Date(startedAt + DURATIONS_MS.GUARDIANSHIP_GRACE).toISOString(),
    });
    return { deadline: startedAt + DURATIONS_MS.GUARDIANSHIP_GRACE };
  }

  // 新监护人在宽限期内确认：表态同意即视为重新确认，关系连续恢复。
  reaffirmGuardianship({ relationshipId, guardianId, consent = true }) {
    const rel = this._requireRel(relationshipId);
    const childId = this._sideOfGuardian(rel, guardianId);
    if (!rel.guardianship || rel.guardianship.childId !== childId || rel.guardianship.reaffirmedAt) {
      throw new Error("该关系不在监护权宽限期中，或新监护人已确认");
    }
    const g = this._guardianship.get(childId);
    if (!g || isExpired(g.deadline, this.now())) throw new Error("监护权宽限期已过");
    rel.guardianDecisions.set(guardianId, consent);
    if (consent) {
      rel.guardianship.reaffirmedAt = this.now();
      this._emit("GUARDIANSHIP_REAFFIRMED", childId, { relationship_id: rel.id });
      this._resumeIfClear(rel);
    } else {
      this._revoke(rel, REASON_CODES.GUARDIAN_CONSENT_WITHDRAWN, { by_guardian: guardianId });
    }
    return this.explain(relationshipId);
  }

  // ---------- 账号跨品牌迁移：14 天重新确认窗口 ----------

  startAccountMigration({ childId, toBrandId, requestedByGuardianId }) {
    const child = this._requireChild(childId);
    if (!child.guardianIds.has(requestedByGuardianId)) throw new Error("必须由孩子的监护人发起迁移");
    const target = this._brands.get(toBrandId);
    if (!target || target.status !== "ACTIVE") return this._deny(REASON_CODES.BRAND_NOT_IN_FEDERATION);
    const startedAt = this.now();
    const fromBrand = child.brandId;
    child.brandId = toBrandId; // 路由立即切向新品牌
    const oldPseudonym = child.pseudonym;
    child.pseudonym = `pseudo-${(++this._seq).toString(36)}-${randomInt(1e5, 1e6).toString(36)}`; // 迁移即换假名
    this._migration.set(childId, { startedAt, deadline: startedAt + DURATIONS_MS.MIGRATION_RECONSENT_WINDOW, fromBrand, toBrandId, oldPseudonym });
    for (const rel of this._relationshipsOf(childId)) {
      if (rel.state === "ACTIVE" || rel.state === "SUSPENDED") {
        rel.migration = { childId, peerConfirmed: false, peerGuardianConsented: false };
        this._suspend(rel, REASON_CODES.MIGRATION_PENDING_RECONSENT);
      }
    }
    this._emit("ACCOUNT_MIGRATION_STARTED", childId, {
      from_brand: fromBrand,
      to_brand: toBrandId,
      reconsent_ends_at: new Date(startedAt + DURATIONS_MS.MIGRATION_RECONSENT_WINDOW).toISOString(),
    });
    return { deadline: startedAt + DURATIONS_MS.MIGRATION_RECONSENT_WINDOW, newPseudonym: child.pseudonym };
  }

  migrationChildReconfirm({ relationshipId, childId }) {
    const rel = this._requireRel(relationshipId);
    if (!rel.migration || !rel.pair.includes(childId) || rel.migration.childId === childId) {
      throw new Error("只有未迁移一方的孩子需要重新确认");
    }
    rel.migration.peerConfirmed = true;
    this._emit("CHILD_CONFIRMED", childId, { relationship_id: rel.id, context: "MIGRATION_RECONFIRM" });
    this._maybeCompleteMigrationReconfirm(rel);
    return this.explain(relationshipId);
  }

  migrationGuardianConsent({ relationshipId, guardianId, decision = true }) {
    const rel = this._requireRel(relationshipId);
    const side = this._sideOfGuardian(rel, guardianId);
    if (!side || side === rel.migration?.childId) throw new Error("只有未迁移一方的监护人需要重新表态");
    rel.guardianDecisions.set(guardianId, decision);
    rel.migration.peerGuardianConsented = decision;
    this._emit(decision ? "GUARDIAN_CONSENTED" : "GUARDIAN_CONSENT_WITHDRAWN", side, {
      relationship_id: rel.id,
      context: "MIGRATION_RECONFIRM",
    });
    this._maybeCompleteMigrationReconfirm(rel);
    return this.explain(relationshipId);
  }

  _maybeCompleteMigrationReconfirm(rel) {
    if (!rel.migration || rel.state !== "SUSPENDED" || rel.suspension?.code !== REASON_CODES.MIGRATION_PENDING_RECONSENT) return;
    if (rel.migration.peerConfirmed && rel.migration.peerGuardianConsented) {
      const migratingChildId = rel.migration.childId;
      const m = this._migration.get(migratingChildId);
      rel.migration = null;
      this._emit("ACCOUNT_MIGRATION_COMPLETED", rel.pair[0], { relationship_id: rel.id });
      // 旧假名的各品牌缓存必须按同一承诺失效（含迁出品牌本身）。
      this._issueCacheDirective(
        rel,
        "IDENTIFIER_ROTATION",
        { old_pseudonym: m?.oldPseudonym },
        [m?.fromBrand, m?.toBrandId, ...rel.pair.filter((id) => id !== migratingChildId).map((id) => this._children.get(id)?.brandId)],
      );
      this._resumeIfClear(rel);
    }
  }

  // ---------- 品牌退出联盟：90 天过渡期 ----------

  declareBrandExit(brandId) {
    const brand = this._brands.get(brandId);
    if (!brand) throw new Error(`未知品牌 ${brandId}`);
    if (brand.status !== "ACTIVE") return brand;
    const declaredAt = this.now();
    brand.status = "EXITING";
    brand.exit = { declaredAt, deadline: declaredAt + DURATIONS_MS.BRAND_EXIT_WINDDOWN };
    this._emit("BRAND_EXIT_DECLARED", brandId, {
      winddown_ends_at: new Date(brand.exit.deadline).toISOString(),
    });
    return { status: brand.status, winddownEndsAt: brand.exit.deadline };
  }

  _brandGate(fromBrandId, toBrandId) {
    for (const brandId of [fromBrandId, toBrandId]) {
      const brand = this._brands.get(brandId);
      if (!brand) return this._deny(REASON_CODES.BRAND_NOT_IN_FEDERATION, { brand_id: brandId });
      if (brand.status === "EXITING") return this._deny(REASON_CODES.BRAND_EXIT_NO_NEW, { brand_id: brandId });
      if (brand.status === "EXITED") return this._deny(REASON_CODES.BRAND_EXIT_TERMINATED, { brand_id: brandId });
    }
    return null;
  }

  // ---------- 紧急联系人例外：单方声明、限时、事后通知 ----------

  declareEmergencyContact({ childId, remotePseudonym, remoteBrandId, reason, declaredByGuardianId }) {
    const child = this._requireChild(childId);
    if (!child.guardianIds.has(declaredByGuardianId)) throw new Error("紧急联系人须由监护人声明");
    if (!remotePseudonym || !remoteBrandId) throw new Error("紧急通道只需对方假名与品牌，不需要其他资料");
    const declaredAt = this.now();
    const rel = {
      id: `emg-${++this._seq}`,
      pair: [childId, null], // 对方孩子身份不在本侧登记——只有最少标识
      introRef: null,
      introKind: "EMERGENCY",
      state: "EMERGENCY_LIMITED",
      createdAt: declaredAt,
      confirmed: { [childId]: true },
      guardianDecisions: new Map([[declaredByGuardianId, true]]),
      grantedCapabilities: ["TEXT", "VOICE"],
      locationSessions: [],
      complaintRefs: [],
      cacheDirectives: [],
      terminalReason: null,
      suspension: null,
      emergency: {
        remote: { federation_pseudonym: remotePseudonym, brand_id: remoteBrandId },
        reason,
        declaredBy: declaredByGuardianId,
        endsAt: declaredAt + DURATIONS_MS.EMERGENCY_CONTACT_TTL,
        notices: [{ brand_id: child.brandId, notified: true }, { brand_id: remoteBrandId, notified: false }],
      },
    };
    this._relationships.set(rel.id, rel);
    this._emit("EMERGENCY_CONTACT_DECLARED", childId, {
      relationship_id: rel.id,
      remote_brand: remoteBrandId,
      reason,
      ends_at: new Date(rel.emergency.endsAt).toISOString(),
    });
    return { relationshipId: rel.id, endsAt: rel.emergency.endsAt };
  }

  markEmergencyNoticeDelivered({ relationshipId, brandId }) {
    const rel = this._requireRel(relationshipId);
    const notice = rel.emergency?.notices.find((n) => n.brand_id === brandId);
    if (notice) notice.notified = true;
    return rel.emergency.notices;
  }

  emergencySend({ relationshipId, capability = "VOICE" }) {
    return this.canUseCapability({ relationshipId, childId: this._requireRel(relationshipId).pair[0], capability });
  }

  // ---------- 跨品牌投诉 / 申诉：不暴露其他儿童资料 ----------

  // 既可以针对一段关系，也可以只凭对方假名+品牌发起（被陌生人打扰、认为被错误阻断等）。
  // 接口刻意不要求、也不接受对方儿童的姓名、账号、学校等资料。
  fileComplaint({ reporterGuardianId, childId, relationshipId = null, aboutPseudonym = null, aboutBrandId = null, category, evidence = null }) {
    if (!COMPLAINT_CATEGORIES.includes(category)) throw new Error(`未知投诉类别: ${category}`);
    const child = this._requireChild(childId);
    if (!child.guardianIds.has(reporterGuardianId)) throw new Error("须由孩子的监护人发起申诉");
    let rel = null;
    let about = null;
    if (relationshipId) {
      rel = this._requireRel(relationshipId);
      if (!rel.pair.includes(childId) && !(rel.emergency && rel.pair[0] === childId)) throw new Error("只能就涉及自己孩子的联系申诉");
      const otherSide = rel.pair.find((id) => id && id !== childId);
      const other = otherSide ? this._children.get(otherSide) : null;
      about = other
        ? { federation_pseudonym: other.pseudonym, brand_id: other.brandId }
        : rel.emergency.remote;
    } else {
      if (!aboutPseudonym || !aboutBrandId) throw new Error("跨品牌申诉至少需要对方假名与品牌");
      if (typeof aboutPseudonym !== "string") throw new Error("申诉对象字段超出最小范围");
      about = { federation_pseudonym: aboutPseudonym, brand_id: aboutBrandId };
    }

    const ref = `cmp-${++this._seq}`;
    const createdAt = this.now();
    const complaint = {
      ref,
      category,
      status: "OPEN",
      createdAt,
      deadline: createdAt + DURATIONS_MS.COMPLAINT_REVIEW_SLA,
      reporterGuardianId,
      childId,
      relationshipId,
      about, // 仅最少标识
      evidenceIds: [],
      resolution: null,
    };
    this._complaints.set(ref, complaint);

    // 证据另行封存：自动留存相关台账摘要（只有事件元数据），投诉人提交的材料原样封存。
    const excerpt = rel
      ? {
          relationship_id: rel.id,
          state_at_filing: rel.state,
          events: this._events.filter((e) => e.payload?.relationship_id === rel.id).map((e) => ({
            event_id: e.event_id,
            kind: e.kind,
            occurred_at: e.occurred_at,
          })),
        }
      : null;
    const sealed = this.vault.seal({
      complaintRef: ref,
      brandId: child.brandId,
      content: { about, category, excerpt, supplied: evidence ?? null },
    });
    complaint.evidenceIds.push(sealed.evidenceId);

    if (rel && (category === "HARASSMENT" || category === "SAFETY_RISK") && (rel.state === "ACTIVE" || rel.state === "SUSPENDED")) {
      this._suspend(rel, REASON_CODES.COMPLAINT_UNDER_REVIEW, { complaint_ref: ref });
      rel.complaintRefs.push(ref);
    } else if (rel && (category === "HARASSMENT" || category === "SAFETY_RISK") && rel.state === "EMERGENCY_LIMITED") {
      // 紧急通道一旦被投诉，立即终止，不留限时尾巴。
      this._terminate(rel, REASON_CODES.RELATIONSHIP_REVOKED, { complaint_ref: ref });
      rel.complaintRefs.push(ref);
    }
    this._emit("COMPLAINT_FILED", childId, { complaint_ref: ref, category, relationship_id: relationshipId });
    return { complaintRef: ref, deadline: complaint.deadline, about };
  }

  // 家长视角的申诉状态：只有处理结论与自己提交的证据编号，没有任何对方孩子资料。
  complaintStatus(complaintRef, guardianId) {
    const c = this._complaints.get(complaintRef);
    if (!c) throw new Error("未知申诉");
    if (c.reporterGuardianId !== guardianId) throw new Error("只能查看自己发起的申诉");
    return {
      complaintRef: c.ref,
      category: c.category,
      status: c.status,
      deadline: c.deadline,
      resolution: c.resolution,
      evidenceIds: c.evidenceIds,
      about: c.about, // 最少标识，白名单字段
    };
  }

  resolveComplaint(complaintRef, { outcome, note = "" }) {
    const c = this._complaints.get(complaintRef);
    if (!c || c.status !== "OPEN") throw new Error("申诉不存在或已处理");
    c.status = "RESOLVED";
    c.resolution = { outcome, note, resolvedAt: this.now() };
    this._emit("COMPLAINT_RESOLVED", c.childId, { complaint_ref: c.ref, outcome });
    if (c.relationshipId) {
      const rel = this._requireRel(c.relationshipId);
      if (outcome === "UPHELD" && rel.state !== "REVOKED" && rel.state !== "TERMINATED") {
        this._revoke(rel, REASON_CODES.RELATIONSHIP_REVOKED, { complaint_ref: c.ref });
      } else if (outcome === "DISMISSED") {
        if (rel.suspension?.complaintRef === c.ref) rel.suspension = null;
        this._resumeIfClear(rel);
      }
    }
    return c.resolution;
  }

  // ---------- 家长可读解释 ----------

  explain(relationshipId) {
    const rel = this._requireRel(relationshipId);
    this._sweepRelationship(rel);
    if (rel.state === "SUSPENDED") this._resumeIfClear(rel);
    const reasons = [];
    const deadlines = {};

    if (rel.state === "PENDING") {
      deadlines.requestExpiresAt = rel.requestDeadline;
      if (!rel.pair.every((id) => rel.confirmed[id])) reasons.push(REASON_CODES.PEER_CONFIRMATION_REQUIRED);
      if (!rel.pair.every((id) => this._sideConsented(rel, id))) reasons.push(REASON_CODES.GUARDIAN_CONSENT_REQUIRED);
    } else if (rel.state === "SUSPENDED") {
      reasons.push(rel.suspension?.code ?? REASON_CODES.COMPLAINT_UNDER_REVIEW);
      const childUnderRebind = rel.pair.find((id) => this._rebinds.get(id) && !this._rebinds.get(id).completedAt && !this._rebinds.get(id).canceledAt);
      const childUnderGuardianship = rel.pair.find((id) => rel.guardianship?.childId === id && !rel.guardianship.reaffirmedAt && this._guardianship.has(id));
      const m = this._migration.get(rel.migration?.childId);
      if (rel.suspension?.code === REASON_CODES.DEVICE_REBIND_PENDING && childUnderRebind) deadlines.rebindExpiresAt = this._rebinds.get(childUnderRebind).deadline;
      if (rel.suspension?.code === REASON_CODES.GUARDIANSHIP_GRACE_PENDING && childUnderGuardianship) deadlines.graceExpiresAt = this._guardianship.get(childUnderGuardianship).deadline;
      if (rel.suspension?.code === REASON_CODES.MIGRATION_PENDING_RECONSENT && m) deadlines.reconfirmExpiresAt = m.deadline;
      if (rel.suspension?.code === REASON_CODES.COMPLAINT_UNDER_REVIEW) deadlines.complaintRef = rel.suspension.complaintRef;
    } else if (rel.state === "REVOKED") {
      reasons.push(rel.terminalReason ?? REASON_CODES.RELATIONSHIP_REVOKED);
    } else if (rel.state === "TERMINATED") {
      reasons.push(rel.terminalReason ?? REASON_CODES.RELATIONSHIP_REVOKED);
    } else if (rel.state === "EMERGENCY_LIMITED") {
      reasons.push(REASON_CODES.EMERGENCY_ONLY);
      deadlines.emergencyExpiresAt = rel.emergency.endsAt;
    }

    const capabilityReport = CAPABILITIES.map((cap) => {
      const viewer = rel.pair[0] ?? rel.pair.find(Boolean);
      const check = this.canUseCapability({ relationshipId, childId: viewer, capability: cap });
      return { capability: cap, allowed: check.allowed, reason: check.reasons[0]?.text ?? null };
    });

    const reasonObjects = reasons.map((code) => ({ code, text: REASON_TEXT[code] ?? code }));
    const allowed = rel.state === "ACTIVE" || rel.state === "EMERGENCY_LIMITED";
    const summary = this._summarize(rel, reasonObjects, deadlines);
    return {
      relationshipId: rel.id,
      state: rel.state,
      allowed,
      reasons: reasonObjects,
      capabilityReport,
      grantedCapabilities: rel.grantedCapabilities,
      deadlines,
      cache: this.cacheStatus(rel.id),
      summary,
    };
  }

  _summarize(rel, reasonObjects, deadlines) {
    const intro = { FACE_TO_FACE_SHORT_CODE: "面对面短码", SCHOOL_ATTESTATION: "学校证明", GUARDIAN_REFERENCE: "监护人引荐", EMERGENCY: "紧急声明" }[rel.introKind] ?? "相识凭证";
    if (rel.state === "ACTIVE") {
      return `这段联系被允许：双方孩子已通过“${intro}”相识并确认，双方监护人已同意；当前开放能力：${rel.grantedCapabilities.map(capabilityName).join("、") || "无"}。`;
    }
    if (rel.state === "PENDING") {
      return `这段联系尚未成立（相识方式：${intro}）。${reasonObjects.map((r) => r.text).join("")}请在 ${new Date(rel.requestDeadline).toLocaleString("zh-CN")} 前完成，逾期请求自动失效。`;
    }
    if (rel.state === "EMERGENCY_LIMITED") {
      return `${reasonObjects[0]?.text ?? ""}通道将于 ${new Date(rel.emergency.endsAt).toLocaleString("zh-CN")} 自动关闭，届时双方监护人都会收到通知。`;
    }
    const tail = Object.entries(deadlines)
      .filter(([, v]) => typeof v === "number")
      .map(([k, v]) => `${deadlineLabel(k)}：${new Date(v).toLocaleString("zh-CN")}`)
      .join("；");
    return `这段联系当前不可用。${reasonObjects.map((r) => r.text).join("")}${tail ? `（${tail}）` : ""}`;
  }

  // 跨品牌联系人视图：只有白名单字段，可在出门前供家长核对。
  minimalContactView({ relationshipId, viewerChildId }) {
    const rel = this._requireRel(relationshipId);
    this._sweepRelationship(rel);
    if (rel.state === "TERMINATED" || rel.state === "REVOKED") {
      return { state: rel.state, federation_pseudonym: null, brand_id: null, age_band: null, intro_ref: null, display_label: null };
    }
    if (rel.emergency) {
      return { state: rel.state, ...rel.emergency.remote, age_band: null, intro_ref: null, display_label: null };
    }
    const otherId = rel.pair.find((id) => id !== viewerChildId);
    const other = this._requireChild(otherId);
    const view = {
      federation_pseudonym: other.pseudonym,
      brand_id: other.brandId,
      age_band: other.ageBand,
      intro_ref: rel.introRef,
      display_label: other.displayLabel,
    };
    const excessive = findExcessiveFields(view);
    if (excessive.length) throw new Error(`联系人视图超出最少标识: ${excessive.join(",")}`);
    return { state: rel.state, ...view };
  }

  // ---------- 超时扫描（幂等，可定时调用） ----------

  sweepTimeouts() {
    const changes = [];
    for (const rel of [...this._relationships.values()]) {
      const before = rel.state;
      this._sweepRelationship(rel);
      if (rel.state !== before) changes.push({ relationshipId: rel.id, from: before, to: rel.state });
    }
    for (const [childId, rb] of this._rebinds) {
      if (!rb.completedAt && !rb.canceledAt && isExpired(rb.deadline, this.now())) {
        rb.canceledAt = this.now(); // 换绑申请逾期失效，沿用原设备
        for (const rel of this._relationshipsOf(childId)) this._resumeIfClear(rel);
        changes.push({ childId, deviceRebind: "EXPIRED_RESUME_OLD_BINDING" });
      }
    }
    for (const directive of [...this._relationships.values()].flatMap((r) => r.cacheDirectives)) {
      if (!directive.overdue && this.now() > directive.deadline && directive.acks.size < directive.brands.length) directive.overdue = true;
    }
    for (const [brandId, brand] of this._brands) {
      if (brand.status === "EXITING" && isExpired(brand.exit.deadline, this.now())) {
        brand.status = "EXITED";
        this._emit("BRAND_EXIT_WINDDOWN_ENDED", brandId, {});
        for (const rel of [...this._relationships.values()]) {
          const involved = rel.emergency
            ? rel.emergency.remote.brand_id === brandId || this._children.get(rel.pair[0])?.brandId === brandId
            : rel.pair.some((id) => this._children.get(id)?.brandId === brandId);
          if (involved && rel.state !== "TERMINATED" && rel.state !== "REVOKED") {
            this._terminate(rel, REASON_CODES.BRAND_EXIT_TERMINATED);
            changes.push({ relationshipId: rel.id, to: "TERMINATED" });
          }
        }
      }
    }
    return changes;
  }

  _sweepRelationship(rel) {
    if (!rel) return;
    const now = this.now();
    if (rel.state === "PENDING" && isExpired(rel.requestDeadline, now)) {
      this._terminate(rel, REASON_CODES.REQUEST_EXPIRED);
      return;
    }
    if (rel.state === "EMERGENCY_LIMITED" && now >= rel.emergency.endsAt) {
      rel.state = "TERMINATED";
      rel.terminalReason = REASON_CODES.EMERGENCY_EXPIRED;
      this._emit("EMERGENCY_CONTACT_EXPIRED", rel.pair[0], { relationship_id: rel.id });
      this._issueCacheDirective(rel, "TERMINATION");
      return;
    }
    const migratingChild = rel.migration?.childId;
    if (migratingChild) {
      const m = this._migration.get(migratingChild);
      if (m && isExpired(m.deadline, now) && rel.state === "SUSPENDED") {
        rel.migration = null;
        this._terminate(rel, REASON_CODES.MIGRATION_RECONSENT_EXPIRED);
        return;
      }
    }
    for (const childId of rel.pair) {
      const g = this._guardianship.get(childId);
      const relG = rel.guardianship?.childId === childId ? rel.guardianship : null;
      if (g && relG && !relG.reaffirmedAt && isExpired(g.deadline, now) && rel.state === "SUSPENDED" && rel.suspension?.code === REASON_CODES.GUARDIANSHIP_GRACE_PENDING) {
        this._terminate(rel, REASON_CODES.GUARDIANSHIP_GRACE_EXPIRED);
        return;
      }
    }
    for (const session of rel.locationSessions) {
      if (!session.closed && now >= session.endsAt) session.closed = true;
    }
  }

  // ---------- 台账读取 ----------

  events(subjectId = null) {
    return subjectId ? this._events.filter((e) => e.subject_id === subjectId || e.payload?.relationship_id && this._relationships.get(e.payload.relationship_id)?.pair.includes(subjectId)) : [...this._events];
  }

  // ---------- 内部工具 ----------

  _suspend(rel, code, extra = {}) {
    if (rel.state === "REVOKED" || rel.state === "TERMINATED" || rel.state === "EMERGENCY_LIMITED") return;
    rel.state = "SUSPENDED";
    rel.suspension = { code, ...extra };
    if (code === REASON_CODES.COMPLAINT_UNDER_REVIEW) {
      this._emit("RELATIONSHIP_SUSPENDED", rel.pair[0], { relationship_id: rel.id, reason_code: code, ...extra });
    }
  }

  // 按固定优先级判断挂起是否仍存在：投诉调查 > 换绑 > 监护权 > 迁移。
  _resumeIfClear(rel) {
    if (rel.state !== "SUSPENDED") return;
    const openComplaint = rel.complaintRefs.some((ref) => this._complaints.get(ref)?.status === "OPEN");
    if (openComplaint) {
      rel.suspension = { code: REASON_CODES.COMPLAINT_UNDER_REVIEW };
      return;
    }
    const rebindChild = rel.pair.find((id) => {
      const rb = this._rebinds.get(id);
      return rb && !rb.completedAt && !rb.canceledAt && this.now() <= rb.deadline;
    });
    if (rebindChild) {
      rel.suspension = { code: REASON_CODES.DEVICE_REBIND_PENDING };
      return;
    }
    const guardChild = rel.pair.find((id) => {
      const g = this._guardianship.get(id);
      const relG = rel.guardianship?.childId === id ? rel.guardianship : null;
      return g && relG && !relG.reaffirmedAt && this.now() <= g.deadline;
    });
    if (guardChild) {
      rel.suspension = { code: REASON_CODES.GUARDIANSHIP_GRACE_PENDING };
      return;
    }
    if (rel.migration) {
      rel.suspension = { code: REASON_CODES.MIGRATION_PENDING_RECONSENT };
      return;
    }
    if (!rel.pair.every((id) => this._sideConsented(rel, id))) {
      // 例如监护权变更后新监护人尚未在本条关系上表态。
      rel.state = "PENDING";
      rel.requestDeadline = this.now() + DURATIONS_MS.FRIEND_REQUEST_TTL;
      rel.suspension = null;
      rel.confirmed = { [rel.pair[0]]: true, [rel.pair[1]]: true };
      return;
    }
    rel.state = "ACTIVE";
    rel.suspension = null;
    if (!rel.activeAt) rel.activeAt = this.now();
  }

  _relationshipsOf(childId) {
    return [...this._relationships.values()].filter((r) => r.pair.includes(childId));
  }

  _pairKey(a, b) {
    return [a, b].sort().join("↔");
  }

  _requireChild(childId) {
    const child = this._children.get(childId);
    if (!child) throw new Error(`未知儿童账号 ${childId}`);
    return child;
  }

  _requireRel(relationshipId) {
    const rel = this._relationships.get(relationshipId);
    if (!rel) throw new Error(`未知关系 ${relationshipId}`);
    return rel;
  }

  _publicChildView(child) {
    return {
      childId: child.childId,
      brandId: child.brandId,
      ageBand: child.ageBand,
      federation_pseudonym: child.pseudonym,
      displayLabel: child.displayLabel,
    };
  }

  _deny(code, extra = {}) {
    return { allowed: false, reasons: [{ code, text: REASON_TEXT[code] ?? code, ...extra }] };
  }

  _allow(text) {
    return { allowed: true, reasons: [{ code: "ALLOWED", text }] };
  }

  _requestView(rel, status) {
    return { status, relationshipId: rel.id, state: rel.state, requestDeadline: rel.requestDeadline ?? null, explain: () => this.explain(rel.id) };
  }

  _emit(kind, subjectId, payload) {
    this._events.push({
      event_id: `evt-${(++this._seq).toString(36)}`,
      kind,
      occurred_at: new Date(this.now()).toISOString(),
      subject_id: subjectId,
      payload,
    });
  }
}

function capabilityName(cap) {
  return { TEXT: "文字", VOICE: "语音", LOCATION: "位置分享", GROUP: "群组" }[cap] ?? cap;
}

function deadlineLabel(key) {
  return {
    rebindExpiresAt: "换绑期限",
    graceExpiresAt: "监护权宽限截止",
    reconfirmExpiresAt: "迁移重新确认截止",
  }[key] ?? key;
}

export { MINIMAL_CONTACT_FIELDS };
