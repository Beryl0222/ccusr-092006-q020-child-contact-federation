// 儿童联系人跨品牌互通服务（参考实现）。
//
// 窄通路总览：
//   监护人真实关系(GUARDIAN_LINKED)
//     -> 一次相识：学校证明(7天/一次) 或 面对面短码(10分钟/一次)
//     -> 加友请求(7天) -> 对方儿童确认 -> 对方监护人同意(7天)
//     -> 关系生效，按双方年龄就低开放 文字/语音/群组；位置始终单独同意 + 限时会话
//     -> 任何一方监护人可撤销：消息/位置立即切断，只读缓存承诺 24h 内失效
//
// 所有命令支持客户端命令号幂等：离线手表重发同一命令只返回首次结果。

import {
  CAPABILITIES,
  REASON_CODES,
  REASON_TEXT,
  validateEvent,
} from "./child_contact_federation.js";
import {
  DEADLINES,
  ageBand,
  capabilityAllowedByAge,
  effectiveCapabilities,
} from "./policy.js";
import {
  deriveHandle,
  projectAppealEnvelope,
  projectExplanation,
  projectFriendRequest,
  projectRouting,
  rotateHandleSalt,
} from "./identifiers.js";
import { EventLog, EvidenceVault } from "./evidence.js";

const hours = (n) => n * 36e5;
const days = (n) => n * 864e5;
const iso = (d) => new Date(d).toISOString();

export class FederationService {
  constructor({ clock = () => new Date(), eventLog = new EventLog(), evidenceVault = new EvidenceVault(clock) } = {}) {
    this.clock = clock;
    this.log = eventLog;
    this.vault = evidenceVault;

    this.brands = new Map();                 // brandId -> { id, status: ACTIVE|SUSPENDED, exitedAt, graceEndsAt }
    this.children = new Map();              // childId -> { id, brandId, ageYears, primaryGuardian, guardians, handleSalt }
    this.intros = new Map();                 // token -> intro record
    this.requests = new Map();              // requestId -> request
    this.relationships = new Map();         // relId -> relationship
    this.pairIndex = new Map();             // 两个儿童的有序键 -> relId，防止重复关系
    this.rebinds = new Map();               // childId -> rebind record
    this.migrations = new Map();            // childId -> migration record
    this.emergency = new Map();             // childId -> [relId...]
    this.appeals = [];
    this.commandIndex = new Map();          // clientCommandId -> 首次结果
    this.seq = 0;
  }

  #id(prefix) {
    this.seq += 1;
    return `${prefix}_${this.seq.toString(36)}${this.clock().getTime().toString(36).slice(-4)}`;
  }

  #emit(kind, subjectId, payload = {}) {
    return this.log.append(kind, subjectId, { ...payload, __at: this.clock().toISOString() });
  }

  // 幂等外壳：同一 clientCommandId 永远返回首次结果，不重复产生关系/事件。
  #runCommand(commandId, label, fn) {
    if (!commandId) return fn();
    if (this.commandIndex.has(commandId)) {
      const first = this.commandIndex.get(commandId);
      this.#emit("COMMAND_DEDUPLICATED", first.subjectId ?? "system", {
        command_id: commandId,
        label,
        first_result: first.result,
      });
      return { ...first.result, duplicated: true };
    }
    const result = fn();
    this.commandIndex.set(commandId, { result, subjectId: result?.subjectId ?? "system" });
    return { ...result, duplicated: false };
  }

  #child(childId) {
    const child = this.children.get(childId);
    if (!child) throw new Error(`UNKNOWN_CHILD:${childId}`);
    return child;
  }

  #guardianVerified(child) {
    return Boolean(child.primaryGuardian && child.guardians.get(child.primaryGuardian)?.status === "VERIFIED");
  }

  #pairKey(a, b) {
    return [a, b].sort().join("::");
  }

  #brandUsable(brandId) {
    const brand = this.brands.get(brandId);
    return brand && brand.status === "ACTIVE";
  }

  // ---- 入网与真实监护关系 -------------------------------------------------

  registerBrand(brandId) {
    if (!this.brands.has(brandId)) this.brands.set(brandId, { id: brandId, status: "ACTIVE" });
    return this.brands.get(brandId);
  }

  // 监护人先建立真实关系：窄通路的根。任何跨品牌动作都要求双方存在已验证监护人。
  registerChild({ childId, brandId, ageYears, guardianId }) {
    this.registerBrand(brandId);
    if (this.children.has(childId)) throw new Error(`CHILD_EXISTS:${childId}`);
    const child = {
      id: childId,
      brandId,
      ageYears,
      primaryGuardian: guardianId,
      guardians: new Map([[guardianId, { status: "VERIFIED", since: this.clock().toISOString() }]]),
      handleSalt: this.#id("salt"),
      transition: null,
    };
    this.children.set(childId, child);
    this.#emit("GUARDIAN_LINKED", childId, { brand_id: brandId, guardian_id: guardianId });
    return childId;
  }

  // ---- 一次相识 -----------------------------------------------------------

  issueIntro({ childId, method, scope = null, commandId }) {
    return this.#runCommand(commandId, "issueIntro", () => {
      const child = this.#child(childId);
      if (!this.#guardianVerified(child)) return { ok: false, reason: REASON_CODES.GUARDIAN_MISSING };
      if (!this.#brandUsable(child.brandId)) return { ok: false, reason: REASON_CODES.BRAND_SUSPENDED };
      const ttl = method === "SCHOOL"
        ? hours(DEADLINES.INTRO_PROOF_SCHOOL_TTL_HOURS)
        : 60_000 * DEADLINES.INTRO_PROOF_F2F_TTL_MINUTES;
      const token = this.#id("intro");
      this.intros.set(token, {
        token,
        method,                                   // SCHOOL | FACE_TO_FACE
        child_id: childId,
        brand_id: child.brandId,
        age_band: `${ageBand(child.ageYears).min}+`,
        scope,                                    // 学校证明可带班级范围码，不含花名册
        issued_at: this.clock().toISOString(),
        expires_at: iso(this.clock().getTime() + ttl),
        redeemed_at: null,
      });
      this.#emit("INTRO_PROOF_ISSUED", childId, {
        token, method, scope, expires_at: this.intros.get(token).expires_at,
      });
      return { ok: true, subjectId: childId, token, expiresAt: this.intros.get(token).expires_at };
    });
  }

  // 兑换一次相识 -> 生成加友请求。凭证一次性，兑换后即焚。
  redeemIntro({ token, childId, commandId }) {
    return this.#runCommand(commandId, "redeemIntro", () => {
      const intro = this.intros.get(token);
      const to = this.#child(childId);
      if (!intro) return { ok: false, reason: REASON_CODES.INTRO_MISSING };
      if (new Date(intro.expires_at) <= this.clock()) return { ok: false, reason: REASON_CODES.INTRO_EXPIRED };
      if (intro.redeemed_at) return { ok: false, reason: REASON_CODES.INTRO_REDEEMED };
      if (!this.#brandUsable(intro.brand_id) || !this.#brandUsable(to.brandId)) {
        return { ok: false, reason: REASON_CODES.BRAND_SUSPENDED };
      }
      const from = this.#child(intro.child_id);
      if (!this.#guardianVerified(from) || !this.#guardianVerified(to)) {
        return { ok: false, reason: REASON_CODES.GUARDIAN_MISSING };
      }
      if (to.transition || from.transition) return { ok: false, reason: REASON_CODES.GUARDIANSHIP_TRANSITION_PENDING };
      if (this.pairIndex.has(this.#pairKey(from.id, to.id))) {
        // 已有关系：生效/撤销中的走既有关系路径；墓碑期过后允许重新相识。
        const existing = this.relationships.get(this.pairIndex.get(this.#pairKey(from.id, to.id)));
        if (existing?.status !== "PURGED") {
          return { ok: false, reason: REASON_CODES.RELATIONSHIP_NOT_ACTIVE, relationshipId: existing?.id };
        }
        this.pairIndex.delete(this.#pairKey(from.id, to.id));
      }

      intro.redeemed_at = this.clock().toISOString();
      const handle = deriveHandle(to.id, from.brandId, to.handleSalt);
      const request = {
        id: this.#id("req"),
        intro_token: token,
        from_child: from.id,
        from_brand: from.brandId,
        to_child: to.id,
        to_brand: to.brandId,
        child_handle: handle,
        age_band: intro.age_band,
        status: "PENDING",                          // PENDING -> CHILD_CONFIRMED -> ACTIVE/DECLINED/EXPIRED/CANCELLED
        created_at: this.clock().toISOString(),
        expires_at: iso(this.clock().getTime() + days(DEADLINES.FRIEND_REQUEST_TTL_DAYS)),
        child_confirmed_at: null,
        consent_deadline: null,
        consented_at: null,
        relationship_id: null,
      };
      this.requests.set(request.id, request);
      // 跨品牌只投送最小投影（假名 + 年龄段 + 一次性凭证），没有孩子档案。
      this.#emit("FRIEND_REQUESTED", to.id, {
        request_id: request.id,
        projection: projectFriendRequest({
          introToken: token,
          fromBrand: request.from_brand,
          toBrand: request.to_brand,
          childHandle: handle,
          ageBand: request.age_band,
        }),
        expires_at: request.expires_at,
      });
      return { ok: true, subjectId: to.id, requestId: request.id, expiresAt: request.expires_at };
    });
  }

  #liveRequest(request) {
    if (!request) return undefined;
    if (request.status === "PENDING" && new Date(request.expires_at) <= this.clock()) {
      request.status = "EXPIRED";
      this.#emit("FRIEND_RESPONDED", request.to_child, { request_id: request.id, response: "EXPIRED" });
    }
    if (request.status === "CHILD_CONFIRMED" && request.consent_deadline &&
        new Date(request.consent_deadline) <= this.clock()) {
      // 监护人 7 天未同意：回退为失效，需要重新发起，不悬挂。
      request.status = "EXPIRED";
      this.#emit("FRIEND_RESPONDED", request.to_child, { request_id: request.id, response: "CONSENT_LAPSED" });
    }
    return request;
  }

  // 被请求方儿童本人确认（双向确认的第二向；第一向是发起请求本身）。
  confirmByChild(requestId, { commandId } = {}) {
    return this.#runCommand(commandId, "confirmByChild", () => {
      const request = this.#liveRequest(this.requests.get(requestId));
      if (!request) return { ok: false, reason: REASON_CODES.REQUEST_EXPIRED };
      if (request.status !== "PENDING") {
        return { ok: false, reason: request.status === "EXPIRED" ? REASON_CODES.REQUEST_EXPIRED : REASON_CODES.RELATIONSHIP_NOT_ACTIVE };
      }
      request.status = "CHILD_CONFIRMED";
      request.child_confirmed_at = this.clock().toISOString();
      request.consent_deadline = iso(this.clock().getTime() + days(DEADLINES.GUARDIAN_CONSENT_TTL_DAYS));
      this.#emit("CONTACT_CONFIRMED_BY_CHILD", request.to_child, {
        request_id: requestId, consent_deadline: request.consent_deadline,
      });
      return { ok: true, subjectId: request.to_child, consentDeadline: request.consent_deadline };
    });
  }

  // 被请求方监护人同意：关系生效的最后闸门。
  grantConsent(requestId, guardianId, { commandId } = {}) {
    return this.#runCommand(commandId, "grantConsent", () => {
      const request = this.#liveRequest(this.requests.get(requestId));
      if (!request || request.status === "EXPIRED") return { ok: false, reason: REASON_CODES.REQUEST_EXPIRED };
      if (request.status === "CANCELLED") return { ok: false, reason: REASON_CODES.REQUEST_CANCELLED };
      if (request.status === "DECLINED") return { ok: false, reason: REASON_CODES.RELATIONSHIP_NOT_ACTIVE };
      const to = this.#child(request.to_child);
      if (to.primaryGuardian !== guardianId) return { ok: false, reason: REASON_CODES.GUARDIAN_MISSING };
      if (request.status !== "CHILD_CONFIRMED") return { ok: false, reason: REASON_CODES.CHILD_CONFIRM_PENDING };
      if (!this.#brandUsable(to.brandId) || !this.#brandUsable(this.#child(request.from_child).brandId)) {
        return { ok: false, reason: REASON_CODES.BRAND_SUSPENDED };
      }
      if (to.transition || this.#child(request.from_child).transition) {
        return { ok: false, reason: REASON_CODES.GUARDIANSHIP_TRANSITION_PENDING };
      }

      const from = this.#child(request.from_child);
      request.status = "ACTIVE";
      request.consented_at = this.clock().toISOString();

      const id = this.#id("rel");
      // 按双方年龄"就低"给出能力上限；位置永不默认开放。
      const grants = new Set();
      for (const cap of ["TEXT", "VOICE", "GROUP"]) {
        if (capabilityAllowedByAge(cap, from.ageYears, to.ageYears)) grants.add(cap);
      }
      const rel = {
        id,
        child_a: from.id, child_b: to.id,
        brand_a: from.brandId, brand_b: to.brandId,
        handle_a: deriveHandle(from.id, to.brandId, from.handleSalt),
        handle_b: request.child_handle,
        status: "ACTIVE",
        grants,
        location_consent: false,
        location_sessions: [],
        emergency: false,
        created_at: this.clock().toISOString(),
        revoked_at: null,
        cache_expires_at: null,
        safety_hold: false,
        transition: to.transition ? { until: to.transition.until, reviewed: false } : null,
      };
      rel.activeCaps = effectiveCapabilities(rel, (cid) => this.#child(cid).ageYears);
      this.relationships.set(id, rel);
      this.pairIndex.set(this.#pairKey(from.id, to.id), id);
      request.relationship_id = id;
      this.#emit("GUARDIAN_CONSENT_GRANTED", to.id, { request_id: requestId, relationship_id: id });
      this.#emit("CONTACT_CONFIRMED", id, {
        relationship_id: id,
        capabilities: [...rel.activeCaps],
        routing: projectRouting(rel),
      });
      for (const cap of rel.activeCaps) {
        this.#emit("CAPABILITY_GRANTED", id, { relationship_id: id, capability: cap, basis: "AGE_BAND_DEFAULT" });
      }
      return { ok: true, subjectId: id, relationshipId: id, capabilities: [...rel.activeCaps] };
    });
  }

  declineRequest(requestId, guardianId, { commandId } = {}) {
    return this.#runCommand(commandId, "declineRequest", () => {
      const request = this.requests.get(requestId);
      if (!request) return { ok: false, reason: REASON_CODES.REQUEST_EXPIRED };
      const to = this.#child(request.to_child);
      if (guardianId !== to.primaryGuardian) return { ok: false, reason: REASON_CODES.GUARDIAN_MISSING };
      request.status = "DECLINED";
      this.#emit("FRIEND_RESPONDED", request.to_child, { request_id: requestId, response: "DECLINED" });
      return { ok: true, subjectId: request.to_child };
    });
  }

  cancelRequest(requestId, guardianId, { commandId } = {}) {
    return this.#runCommand(commandId, "cancelRequest", () => {
      const request = this.#liveRequest(this.requests.get(requestId));
      if (!request) return { ok: false, reason: REASON_CODES.REQUEST_EXPIRED };
      const from = this.#child(request.from_child);
      if (guardianId !== from.primaryGuardian) return { ok: false, reason: REASON_CODES.GUARDIAN_MISSING };
      if (!["PENDING", "CHILD_CONFIRMED"].includes(request.status)) {
        return { ok: false, reason: REASON_CODES.RELATIONSHIP_NOT_ACTIVE };
      }
      request.status = "CANCELLED";
      this.#emit("FRIEND_RESPONDED", request.to_child, { request_id: requestId, response: "CANCELLED" });
      return { ok: true, subjectId: request.from_child };
    });
  }

  // ---- 能力：逐条收窄 / 恢复；位置单独同意 --------------------------------

  setCapability(relId, guardianId, capability, enabled, { commandId } = {}) {
    return this.#runCommand(commandId, "setCapability", () => {
      const rel = this.relationships.get(relId);
      if (!rel || rel.status === "PURGED") return { ok: false, reason: REASON_CODES.RELATIONSHIP_NOT_ACTIVE };
      if (!CAPABILITIES.includes(capability)) return { ok: false, reason: REASON_CODES.CAPABILITY_NOT_GRANTED_FOR_AGE };
      if (!this.#isGuardianOf(guardianId, rel.child_a) && !this.#isGuardianOf(guardianId, rel.child_b)) {
        return { ok: false, reason: REASON_CODES.GUARDIAN_MISSING };
      }
      if (rel.status !== "ACTIVE") {
        return { ok: false, reason: REASON_CODES.RELATIONSHIP_NOT_ACTIVE };
      }
      if (capability === "LOCATION") {
        // 位置没有"常开授权"这一档，只能开限时会话。
        return enabled
          ? { ok: false, reason: REASON_CODES.LOCATION_REQUIRES_SEPARATE_CONSENT }
          : this.#closeLocation(rel, "GUARDIAN_REVOKED");
      }
      if (rel.transition && enabled) return { ok: false, reason: REASON_CODES.GUARDIANSHIP_TRANSITION_PENDING };
      const a = this.#child(rel.child_a), b = this.#child(rel.child_b);
      if (enabled && !capabilityAllowedByAge(capability, a.ageYears, b.ageYears)) {
        return { ok: false, reason: REASON_CODES.CAPABILITY_NOT_GRANTED_FOR_AGE };
      }
      if (enabled) rel.grants.add(capability); else rel.grants.delete(capability);
      rel.activeCaps = effectiveCapabilities(rel, (cid) => this.#child(cid).ageYears);
      this.#emit(enabled ? "CAPABILITY_GRANTED" : "CAPABILITY_REVOKED", relId, {
        relationship_id: relId, capability, set_by: guardianId,
      });
      return { ok: true, subjectId: relId, capabilities: [...rel.activeCaps] };
    });
  }

  #isGuardianOf(guardianId, childId) {
    const child = this.children.get(childId);
    return child?.primaryGuardian === guardianId;
  }

  // 位置分享：监护人的独立同意动作，开启一个限时会话（默认 1 小时，到时自动结束）。
  startLocationSession(relId, guardianId, { ttlHours = DEADLINES.LOCATION_SESSION_DEFAULT_HOURS, commandId } = {}) {
    return this.#runCommand(commandId, "startLocationSession", () => {
      const rel = this.relationships.get(relId);
      if (!rel) return { ok: false, reason: REASON_CODES.RELATIONSHIP_NOT_ACTIVE };
      if (!this.#isGuardianOf(guardianId, rel.child_a) && !this.#isGuardianOf(guardianId, rel.child_b)) {
        return { ok: false, reason: REASON_CODES.GUARDIAN_MISSING };
      }
      // 紧急关系豁免年龄矩阵（低龄儿童找家长/老师）；普通关系必须达到位置开放年龄。
      // 注意：开启会话这个动作本身就是独立同意，不能用"没有进行中的会话"来阻断自己。
      if (rel.emergency) {
        const decision = this.#evaluate(rel, "TEXT", guardianId);
        if (!decision.allowed) return { ok: false, reason: decision.reasonCode };
      } else {
        const a = this.#child(rel.child_a), b = this.#child(rel.child_b);
        if (rel.status !== "ACTIVE") return { ok: false, reason: REASON_CODES.RELATIONSHIP_NOT_ACTIVE };
        if (rel.safety_hold) return { ok: false, reason: REASON_CODES.SAFETY_HOLD };
        if (!capabilityAllowedByAge("LOCATION", a.ageYears, b.ageYears)) {
          return { ok: false, reason: REASON_CODES.CAPABILITY_NOT_GRANTED_FOR_AGE };
        }
      }
      const session = {
        id: this.#id("loc"),
        started_at: this.clock().toISOString(),
        ends_at: iso(this.clock().getTime() + hours(ttlHours)),
        ended_at: null,
      };
      rel.location_consent = true;
      rel.location_sessions.push(session);
      rel.activeCaps.add("LOCATION");
      this.#emit("LOCATION_SESSION_STARTED", relId, {
        relationship_id: relId, session_id: session.id, ends_at: session.ends_at,
      });
      return { ok: true, subjectId: relId, sessionId: session.id, endsAt: session.ends_at };
    });
  }

  #closeLocation(rel, why) {
    let changed = false;
    for (const s of rel.location_sessions) {
      if (!s.ended_at && new Date(s.ends_at) > this.clock()) {
        s.ended_at = this.clock().toISOString();
        changed = true;
      }
    }
    rel.location_consent = false;
    rel.activeCaps?.delete("LOCATION");
    if (changed) this.#emit("LOCATION_SESSION_ENDED", rel.id, { relationship_id: rel.id, why });
    return { ok: true, subjectId: rel.id };
  }

  // ---- 判定与可解释性 -----------------------------------------------------

  #evaluate(rel, capability, actorId = null) {
    const deny = (reasonCode, extra = {}) => ({
      allowed: false,
      reason: reasonCode, // 公共别名，与命令返回对象保持一致
      relationshipId: rel?.id ?? null,
      capability,
      reasonCode,
      reasonText: REASON_TEXT[reasonCode],
      peerBrand: null,
      peerHandle: null,
      ...extra,
    });
    if (!rel || rel.status === "PURGED") return deny(REASON_CODES.RELATIONSHIP_NOT_ACTIVE);
    if (rel.status === "REVOKED") {
      return deny(REASON_CODES.CACHE_PENDING_EXPIRY, { expiresAt: rel.cache_expires_at });
    }
    if (rel.status === "SUSPENDED") return deny(REASON_CODES.BRAND_SUSPENDED);
    if (rel.safety_hold) return deny(REASON_CODES.SAFETY_HOLD);
    if (this.rebinds.get(rel.child_a)?.status === "PENDING" ||
        this.rebinds.get(rel.child_b)?.status === "PENDING") {
      const rb = this.rebinds.get(rel.child_a) ?? this.rebinds.get(rel.child_b);
      return deny(REASON_CODES.DEVICE_REBINDING_PENDING, { expiresAt: rb.expires_at });
    }
    if (!this.#brandUsable(rel.brand_a) || !this.#brandUsable(rel.brand_b)) {
      return deny(REASON_CODES.BRAND_SUSPENDED);
    }
    if (rel.emergency) {
      const list = this.emergency.get(rel.child_b) ?? this.emergency.get(rel.child_a) ?? [];
      const entry = list.find((e) => e.relId === rel.id);
      if (entry && new Date(entry.next_review_at) <= this.clock()) {
        return deny(REASON_CODES.EMERGENCY_REVIEW_DUE, { expiresAt: entry.next_review_at });
      }
      if (capability === "LOCATION" && !this.#activeLocation(rel)) {
        // 开启限时位置会话这个动作本身就是独立同意；会话不存在或已结束时统一如此告知。
        return deny(REASON_CODES.LOCATION_SESSION_CLOSED);
      }
      return {
        allowed: true, relationshipId: rel.id, capability,
        reasonCode: REASON_CODES.OK, reasonText: REASON_CODES.OK,
        peerBrand: null, peerHandle: null,
      };
    }
    if (rel.status !== "ACTIVE") return deny(REASON_CODES.RELATIONSHIP_NOT_ACTIVE);
    const a = this.#child(rel.child_a), b = this.#child(rel.child_b);
    if (!this.#guardianVerified(a) || !this.#guardianVerified(b)) {
      return deny(REASON_CODES.GUARDIAN_MISSING);
    }
    if (capability === "LOCATION") {
      if (!capabilityAllowedByAge("LOCATION", a.ageYears, b.ageYears)) {
        return deny(REASON_CODES.CAPABILITY_NOT_GRANTED_FOR_AGE);
      }
      if (!this.#activeLocation(rel)) return deny(REASON_CODES.LOCATION_SESSION_CLOSED);
    } else if (!capabilityAllowedByAge(capability, a.ageYears, b.ageYears) || !rel.grants.has(capability)) {
      return deny(REASON_CODES.CAPABILITY_NOT_GRANTED_FOR_AGE);
    }
    return {
      allowed: true, relationshipId: rel.id, capability,
      reasonCode: REASON_CODES.OK, reasonText: REASON_CODES.OK,
      peerBrand: actorId === rel.child_a ? rel.brand_b : rel.brand_a,
      peerHandle: actorId === rel.child_a ? rel.handle_b : rel.handle_a,
    };
  }

  #activeLocation(rel) {
    return rel.location_sessions.some((s) => !s.ended_at && new Date(s.ends_at) > this.clock());
  }

  // 业务侧投递前的闸门；家长端 explain 用同一套判定，保证"所见即所判"。
  authorize(relId, capability, actorId = null) {
    return this.#evaluate(this.relationships.get(relId), capability, actorId);
  }

  // 家长读得懂的一张卡片：为什么这条联系此刻被允许/阻断。
  explain(relId, capability, actorId = null) {
    const rel = this.relationships.get(relId);
    const decision = this.#evaluate(rel, capability, actorId);
    // 即使被阻断，也要让家长认出"是哪条联系"：品牌 + 掩码假名，不含真实档案。
    if (rel && !decision.peerBrand && rel.status !== "PURGED") {
      decision.peerBrand = actorId === rel.child_a ? rel.brand_b : rel.brand_a;
      decision.peerHandle = actorId === rel.child_a ? rel.handle_b : rel.handle_a;
    }
    const card = projectExplanation(decision);
    this.#emit("DECISION_LOGGED", relId ?? "system", {
      relationship_id: relId, capability, card,
    });
    return card;
  }

  routingProjection(relId) {
    const rel = this.relationships.get(relId);
    if (!rel || rel.status === "PURGED") return null;
    return projectRouting({ ...rel, activeCaps: rel.activeCaps ?? new Set() });
  }

  // ---- 撤销与缓存失效承诺 -------------------------------------------------

  revokeRelationship(relId, guardianId, { commandId } = {}) {
    return this.#runCommand(commandId, "revokeRelationship", () => {
      const rel = this.relationships.get(relId);
      if (!rel || ["REVOKED", "PURGED"].includes(rel.status)) {
        return { ok: false, reason: REASON_CODES.RELATIONSHIP_NOT_ACTIVE };
      }
      if (!this.#isGuardianOf(guardianId, rel.child_a) && !this.#isGuardianOf(guardianId, rel.child_b)) {
        return { ok: false, reason: REASON_CODES.GUARDIAN_MISSING };
      }
      rel.status = "REVOKED";
      rel.revoked_at = this.clock().toISOString();
      rel.cache_expires_at = iso(this.clock().getTime() + hours(DEADLINES.CACHE_EXPIRY_HOURS));
      this.#closeLocation(rel, "RELATIONSHIP_REVOKED");
      this.#emit("RELATIONSHIP_REVOKED", relId, {
        relationship_id: relId,
        revoked_by: guardianId,
        // 对各方缓存的承诺：此时刻之后只读副本必须失效
        cache_expires_at: rel.cache_expires_at,
        delivery_effect: "IMMEDIATE",
      });
      return {
        ok: true, subjectId: relId,
        revokedAt: rel.revoked_at, cacheExpiresAt: rel.cache_expires_at,
      };
    });
  }

  // ---- 设备换绑：3 天确认期，关系不重建 -----------------------------------

  requestRebind(childId, newDeviceId, { commandId } = {}) {
    return this.#runCommand(commandId, "requestRebind", () => {
      this.#child(childId);
      const pending = this.rebinds.get(childId);
      if (pending?.status === "PENDING") return { ok: true, subjectId: childId, rebind: pending };
      const record = {
        child_id: childId,
        new_device_id: newDeviceId,
        status: "PENDING",
        started_at: this.clock().toISOString(),
        expires_at: iso(this.clock().getTime() + days(DEADLINES.DEVICE_REBIND_TTL_DAYS)),
        confirmed_at: null,
      };
      this.rebinds.set(childId, record);
      this.#emit("DEVICE_REBIND_REQUESTED", childId, { expires_at: record.expires_at });
      return { ok: true, subjectId: childId, rebind: record };
    });
  }

  confirmRebind(childId, guardianId, { commandId } = {}) {
    return this.#runCommand(commandId, "confirmRebind", () => {
      const record = this.rebinds.get(childId);
      if (!record || record.status !== "PENDING") return { ok: false, reason: REASON_CODES.DEVICE_REBINDING_PENDING };
      if (!this.#isGuardianOf(guardianId, childId)) return { ok: false, reason: REASON_CODES.GUARDIAN_MISSING };
      if (new Date(record.expires_at) <= this.clock()) {
        record.status = "CANCELLED";
        return { ok: false, reason: REASON_CODES.DEVICE_REBINDING_PENDING };
      }
      record.status = "CONFIRMED";
      record.confirmed_at = this.clock().toISOString();
      this.#emit("DEVICE_REBIND_CONFIRMED", childId, { phase: "CONFIRMED", new_device_id: record.new_device_id });
      return { ok: true, subjectId: childId };
    });
  }

  // ---- 连续路径 1：监护权改变 ---------------------------------------------
  //
  // 老联系人不立刻断裂：进入 30 天只读宽限，等待新监护人逐条复核；
  // 逾期未复核的关系自动撤销（仍走 24h 缓存承诺）。期间不能新增能力/新联系。

  changeGuardianship(childId, newGuardianId, { commandId } = {}) {
    return this.#runCommand(commandId, "changeGuardianship", () => {
      const child = this.#child(childId);
      const until = iso(this.clock().getTime() + days(DEADLINES.GUARDIANSHIP_GRACE_DAYS));
      child.guardians.set(newGuardianId, { status: "VERIFIED", since: this.clock().toISOString() });
      child.primaryGuardian = newGuardianId;
      child.transition = { new_guardian: newGuardianId, until, started_at: this.clock().toISOString() };
      for (const rel of this.relationships.values()) {
        if (rel.child_a === childId || rel.child_b === childId) {
          if (rel.status === "ACTIVE") rel.transition = { until, reviewed: false };
        }
      }
      this.#emit("GUARDIANSHIP_CHANGED", childId, {
        new_guardian: newGuardianId, grace_until: until, grace_days: DEADLINES.GUARDIANSHIP_GRACE_DAYS,
      });
      return { ok: true, subjectId: childId, graceUntil: until };
    });
  }

  // 新监护人对一条老关系表态：保留(重新同意) 或 立即撤销。
  reviewUnderNewGuardian(relId, newGuardianId, approved, { commandId } = {}) {
    return this.#runCommand(commandId, "reviewUnderNewGuardian", () => {
      const rel = this.relationships.get(relId);
      if (!rel) return { ok: false, reason: REASON_CODES.RELATIONSHIP_NOT_ACTIVE };
      const childId = this.#isGuardianOf(newGuardianId, rel.child_a) ? rel.child_a
        : this.#isGuardianOf(newGuardianId, rel.child_b) ? rel.child_b : null;
      if (!childId) return { ok: false, reason: REASON_CODES.GUARDIAN_MISSING };
      if (!approved) return this.revokeRelationship(relId, newGuardianId);
      rel.transition = null;
      // 该儿童的全部老关系都已复核（或已撤销）：结束监护权过渡期。
      const remaining = [...this.relationships.values()].some(
        (r) => (r.child_a === childId || r.child_b === childId) && r.transition && r.status === "ACTIVE",
      );
      if (!remaining) this.#child(childId).transition = null;
      this.#emit("GUARDIANSHIP_CHANGED", relId, { relationship_id: relId, review: "RECONSENTED", by: newGuardianId });
      return { ok: true, subjectId: relId };
    });
  }

  // ---- 连续路径 2：账号迁移（含手柄轮换）----------------------------------

  migrateAccount(childId, { newBrandId = null, commandId } = {}) {
    return this.#runCommand(commandId, "migrateAccount", () => {
      const child = this.#child(childId);
      if (this.migrations.get(childId)?.status === "OPEN") return { ok: true, subjectId: childId, migration: this.migrations.get(childId) };
      const oldSalt = child.handleSalt;
      const newSalt = rotateHandleSalt(oldSalt);
      const record = {
        child_id: childId,
        old_salt: oldSalt,
        new_salt: newSalt,
        status: "OPEN",
        started_at: this.clock().toISOString(),
        expires_at: iso(this.clock().getTime() + days(DEADLINES.MIGRATION_TTL_DAYS)),
        completed_at: null,
      };
      this.migrations.set(childId, record);
      child.handleSalt = newSalt;
      if (newBrandId) {
        this.registerBrand(newBrandId);
        child.brandId = newBrandId;
      }
      // 立即换发新手柄；窗口期内旧手柄仍可路由，窗口后不可链接。
      for (const rel of this.relationships.values()) {
        if (rel.status === "PURGED") continue;
        if (rel.child_a === childId) rel.handle_a = deriveHandle(childId, rel.brand_b, newSalt);
        if (rel.child_b === childId) rel.handle_b = deriveHandle(childId, rel.brand_a, newSalt);
      }
      this.#emit("ACCOUNT_MIGRATED", childId, {
        old_handle_valid_until: record.expires_at, new_brand: newBrandId,
      });
      return { ok: true, subjectId: childId, handleValidUntil: record.expires_at };
    });
  }

  // 路由侧解析手柄：迁移窗口内同时承认新旧。
  resolveHandle(childId, presentedHandle, peerBrandId) {
    const child = this.#child(childId);
    const migration = this.migrations.get(childId);
    if (deriveHandle(childId, peerBrandId, child.handleSalt) === presentedHandle) return { resolves: true, vintage: "CURRENT" };
    if (migration?.status === "OPEN" && new Date(migration.expires_at) > this.clock() &&
        deriveHandle(childId, peerBrandId, migration.old_salt) === presentedHandle) {
      return { resolves: true, vintage: "PREVIOUS_GRACE" };
    }
    return { resolves: false };
  }

  // ---- 连续路径 3：品牌退出联盟 -------------------------------------------
  //
  // 即时暂停新联系与投递；给出 90 天迁移豁免：用户带着账号迁走的关系恢复；
  // 90 天后仍挂起的关系自动撤销，同样遵守 24h 缓存承诺。

  brandExit(brandId, { commandId } = {}) {
    return this.#runCommand(commandId, "brandExit", () => {
      const brand = this.registerBrand(brandId);
      brand.status = "SUSPENDED";
      brand.exitedAt = this.clock().toISOString();
      brand.graceEndsAt = iso(this.clock().getTime() + days(DEADLINES.BRAND_EXIT_SUSPEND_DAYS));
      for (const rel of this.relationships.values()) {
        if ((rel.brand_a === brandId || rel.brand_b === brandId) && rel.status === "ACTIVE") {
          rel.status = "SUSPENDED";
          rel.suspended_for_brand_exit = brandId;
        }
      }
      this.#emit("BRAND_EXITED_ALLIANCE", brandId, { grace_until: brand.graceEndsAt });
      return { ok: true, subjectId: brandId, graceUntil: brand.graceEndsAt };
    });
  }

  // 关系的一方已随迁移落到存续品牌：该关系退出挂起、恢复生效。
  restoreAfterMigration(relId, { commandId } = {}) {
    return this.#runCommand(commandId, "restoreAfterMigration", () => {
      const rel = this.relationships.get(relId);
      if (!rel || rel.status !== "SUSPENDED" || !rel.suspended_for_brand_exit) {
        return { ok: false, reason: REASON_CODES.RELATIONSHIP_NOT_ACTIVE };
      }
      const exited = rel.suspended_for_brand_exit;
      const childOnExited = rel.brand_a === exited ? rel.child_a : rel.child_b;
      const child = this.#child(childOnExited);
      if (child.brandId === exited) return { ok: false, reason: REASON_CODES.BRAND_SUSPENDED };
      rel.brand_a = this.#child(rel.child_a).brandId;
      rel.brand_b = this.#child(rel.child_b).brandId;
      rel.status = "ACTIVE";
      delete rel.suspended_for_brand_exit;
      // 紧急关系是监护预设例外，恢复后仍保留例外能力；普通关系重新按年龄矩阵计算。
      rel.activeCaps = rel.emergency
        ? new Set(["TEXT", "VOICE"])
        : effectiveCapabilities(rel, (cid) => this.#child(cid).ageYears);
      this.#emit("ACCOUNT_MIGRATED", relId, { relationship_id: relId, effect: "RELATIONSHIP_RESTORED" });
      return { ok: true, subjectId: relId };
    });
  }

  // ---- 连续路径 4：紧急联系人例外 -----------------------------------------
  //
  // 唯一不需要"一次相识"的入口：监护人预设的真实紧急关系，绕过年龄矩阵，
  // 但每 90 天必须复核；逾期未复核，能力暂停（含位置），直到再次确认。
  // 位置同样是限时会话，不常开。

  declareEmergencyContact(childId, peerChildId, guardianId, { commandId } = {}) {
    return this.#runCommand(commandId, "declareEmergencyContact", () => {
      const child = this.#child(childId);
      const peer = this.#child(peerChildId);
      if (child.primaryGuardian !== guardianId) return { ok: false, reason: REASON_CODES.GUARDIAN_MISSING };
      const list = this.emergency.get(childId) ?? [];
      if (list.length >= DEADLINES.EMERGENCY_CONTACT_LIMIT &&
          !list.some((e) => e.peer === peerChildId)) {
        return { ok: false, reason: REASON_CODES.EMERGENCY_LIMIT_EXCEEDED };
      }
      let relId = this.pairIndex.get(this.#pairKey(childId, peerChildId));
      let rel = relId ? this.relationships.get(relId) : null;
      if (!rel) {
        relId = this.#id("rel");
        rel = {
          id: relId,
          child_a: childId, child_b: peerChildId,
          brand_a: child.brandId, brand_b: peer.brandId,
          handle_a: deriveHandle(childId, peer.brandId, child.handleSalt),
          handle_b: deriveHandle(peerChildId, child.brandId, peer.handleSalt),
          status: "ACTIVE",
          grants: new Set(["TEXT", "VOICE"]), // 紧急例外：语音不受年龄矩阵限制
          activeCaps: new Set(["TEXT", "VOICE"]),
          location_consent: false,
          location_sessions: [],
          emergency: true,
          created_at: this.clock().toISOString(),
          revoked_at: null, cache_expires_at: null, safety_hold: false, transition: null,
        };
        this.relationships.set(relId, rel);
        this.pairIndex.set(this.#pairKey(childId, peerChildId), relId);
      } else if (rel.emergency) {
        // 已在紧急列表中：刷新复核期即可，不重复声明。
      } else if (rel.status === "REVOKED" || rel.status === "PURGED") {
        // 监护人在已撤销/已过缓存期的关系上显式声明紧急关系：重新激活。
        rel.status = "ACTIVE";
        rel.revoked_at = null;
        rel.cache_expires_at = null;
        rel.emergency = true;
        rel.grants = new Set(["TEXT", "VOICE"]);
        rel.activeCaps = new Set(["TEXT", "VOICE"]);
        if (rel.status === "PURGED" || !rel.handle_a) {
          rel.child_a = childId;
          rel.child_b = peerChildId;
          rel.handle_a = deriveHandle(childId, peer.brandId, child.handleSalt);
          rel.handle_b = deriveHandle(peerChildId, child.brandId, peer.handleSalt);
        }
      } else if (rel.status === "ACTIVE") {
        // 普通关系升级为紧急关系，获得矩阵外能力（语音等）。
        rel.emergency = true;
        rel.grants = new Set(["TEXT", "VOICE"]);
        rel.activeCaps = new Set(["TEXT", "VOICE"]);
      } else {
        return { ok: false, reason: REASON_CODES.BRAND_SUSPENDED };
      }
      const entry = {
        relId, peer: peerChildId,
        declared_at: this.clock().toISOString(),
        last_reviewed_at: this.clock().toISOString(),
        next_review_at: iso(this.clock().getTime() + days(DEADLINES.EMERGENCY_REVIEW_DAYS)),
      };
      const without = (list ?? []).filter((e) => e.peer !== peerChildId);
      without.push(entry);
      this.emergency.set(childId, without);
      this.#emit("EMERGENCY_CONTACT_DECLARED", childId, {
        relationship_id: relId, next_review_at: entry.next_review_at,
      });
      return { ok: true, subjectId: childId, relationshipId: relId, nextReviewAt: entry.next_review_at };
    });
  }

  reviewEmergencyContact(relId, guardianId, { commandId } = {}) {
    return this.#runCommand(commandId, "reviewEmergencyContact", () => {
      const rel = this.relationships.get(relId);
      if (!rel?.emergency) return { ok: false, reason: REASON_CODES.RELATIONSHIP_NOT_ACTIVE };
      const ownerId = this.#isGuardianOf(guardianId, rel.child_a) ? rel.child_a
        : this.#isGuardianOf(guardianId, rel.child_b) ? rel.child_b : null;
      if (!ownerId) return { ok: false, reason: REASON_CODES.GUARDIAN_MISSING };
      const list = this.emergency.get(ownerId);
      const entry = list?.find((e) => e.relId === relId);
      if (!entry) return { ok: false, reason: REASON_CODES.RELATIONSHIP_NOT_ACTIVE };
      entry.last_reviewed_at = this.clock().toISOString();
      entry.next_review_at = iso(this.clock().getTime() + days(DEADLINES.EMERGENCY_REVIEW_DAYS));
      this.#emit("EMERGENCY_CONTACT_REVIEWED", ownerId, {
        relationship_id: relId, next_review_at: entry.next_review_at,
      });
      return { ok: true, subjectId: ownerId, nextReviewAt: entry.next_review_at };
    });
  }

  // ---- 安全投诉：证据另行封存 + 跨品牌申诉 -------------------------------
  //
  // fileSafetyReport 返回证据引用；业务流与申诉信封只传递引用，不传递内容。
  // placeHold 可依联盟处置流程把该关系置于安全冻结（任何能力都判 SAFETY_HOLD）。

  fileSafetyReport({ reporterChildId, relationshipId, category, facts, attachments = [], placeHold = false }) {
    const ref = this.vault.seal({
      reporterId: reporterChildId,
      relationshipId,
      category,
      facts,
      attachments,
    });
    if (placeHold) {
      const rel = this.relationships.get(relationshipId);
      if (rel) rel.safety_hold = true;
    }
    this.#emit("SAFETY_REPORT_FILED", relationshipId ?? reporterChildId, {
      evidence_ref: ref, category, hold: placeHold,
    });
    return { evidenceRef: ref, sealed: true };
  }

  // 跨品牌申诉：信封结构性不携带其他儿童资料（见 projectAppealEnvelope）。
  fileAppeal({ relationshipId, reporterBrand, respondentBrand, category, detail = null, evidenceRef = null, commandId }) {
    return this.#runCommand(commandId, "fileAppeal", () => {
      const envelope = projectAppealEnvelope({
        relationshipId,
        eventRef: evidenceRef,
        reporterBrand,
        respondentBrand,
        category,
        detail,
      });
      const appeal = {
        id: this.#id("appeal"),
        envelope,
        status: "OPEN",
        created_at: this.clock().toISOString(),
        resolved_at: null,
        resolution: null,
      };
      this.appeals.push(appeal);
      this.#emit("SAFETY_REPORT_FILED", relationshipId, { appeal_id: appeal.id, schema: envelope.schema });
      return { ok: true, subjectId: relationshipId, appealId: appeal.id, envelope };
    });
  }

  appealsFor(brandId) {
    // 被申诉品牌只看到信封：本条关系引用 + 证据引用，没有其他孩子的档案。
    return this.appeals.filter((a) => a.envelope.respondent_brand === brandId);
  }

  resolveAppeal(appealId, brandId, resolution, { liftHold = false } = {}) {
    const appeal = this.appeals.find((a) => a.id === appealId);
    if (!appeal || appeal.envelope.respondent_brand !== brandId) {
      return { ok: false, reason: REASON_CODES.RELATIONSHIP_NOT_ACTIVE };
    }
    appeal.status = "RESOLVED";
    appeal.resolved_at = this.clock().toISOString();
    appeal.resolution = resolution;
    if (liftHold) {
      const rel = this.relationships.get(appeal.envelope.relationship_ref);
      if (rel) rel.safety_hold = false;
    }
    this.#emit("SAFETY_REPORT_FILED", appeal.envelope.relationship_ref, {
      appeal_id: appealId, resolution,
    });
    return { ok: true, subjectId: appeal.envelope.relationship_ref };
  }

  // ---- 期限清扫：所有等待状态在此落定 ------------------------------------

  sweep(at = this.clock()) {
    const saved = this.clock;
    // 让本次清扫产生的事件时间与调用者给定的时刻一致。
    this.clock = () => (at instanceof Date ? at : new Date(at));
    const effects = [];

    for (const intro of this.intros.values()) {
      if (!intro.redeemed_at && new Date(intro.expires_at) <= this.clock()) intro.redeemed_at = "__expired__";
    }
    for (const request of this.requests.values()) this.#liveRequest(request);

    for (const [childId, rb] of this.rebinds) {
      if (rb.status === "PENDING" && new Date(rb.expires_at) <= this.clock()) {
        rb.status = "CANCELLED";
        effects.push({ type: "REBIND_CANCELLED", childId });
      }
    }

    for (const [childId, migration] of this.migrations) {
      if (migration.status === "OPEN" && new Date(migration.expires_at) <= this.clock()) {
        migration.status = "CLOSED";
        migration.completed_at = this.clock().toISOString();
        effects.push({ type: "OLD_HANDLE_INVALID", childId });
      }
    }

    for (const rel of this.relationships.values()) {
      for (const s of rel.location_sessions) {
        if (!s.ended_at && new Date(s.ends_at) <= this.clock()) {
          s.ended_at = this.clock().toISOString();
          rel.location_consent = false;
          rel.activeCaps?.delete("LOCATION");
          this.#emit("LOCATION_SESSION_ENDED", rel.id, { why: "TTL" });
        }
      }
      if (rel.status === "REVOKED" && new Date(rel.cache_expires_at) <= this.clock()) {
        // 承诺时刻到达：清掉标识，只留无含义的墓碑，防止撤销后重建出第二条关系。
        const tombstone = rel.id;
        Object.assign(rel, {
          status: "PURGED",
          handle_a: null, handle_b: null, child_a: null, child_b: null,
          grants: new Set(), activeCaps: new Set(), location_sessions: [],
        });
        effects.push({ type: "CACHE_EXPIRED", relationshipId: tombstone });
      }
      if (rel.status === "ACTIVE" && rel.transition && new Date(rel.transition.until) <= this.clock() &&
          !rel.transition.reviewed) {
        const childId = [rel.child_a, rel.child_b].find((c) => this.children.get(c)?.transition);
        if (childId) {
          const guardianId = this.#child(childId).primaryGuardian;
          this.revokeRelationship(rel.id, guardianId);
          effects.push({ type: "GUARDIANSHIP_GRACE_LAPSED", relationshipId: rel.id });
        }
      }
    }

    // 宽限期已过：未被新监护人保留的关系均已落定，清除儿童身上的过渡标记。
    for (const child of this.children.values()) {
      if (child.transition && new Date(child.transition.until) <= this.clock()) {
        child.transition = null;
      }
    }

    for (const [brandId, brand] of this.brands) {
      if (brand.status === "SUSPENDED" && new Date(brand.graceEndsAt) <= this.clock()) {
        for (const rel of this.relationships.values()) {
          if (rel.status === "SUSPENDED" && rel.suspended_for_brand_exit === brandId) {
            const survivingChild = rel.brand_a === brandId ? rel.child_b : rel.child_a;
            if (survivingChild) {
              this.revokeRelationship(rel.id, this.#child(survivingChild).primaryGuardian);
              effects.push({ type: "BRAND_EXIT_REVOKED", relationshipId: rel.id });
            }
          }
        }
      }
    }

    for (const list of this.emergency.values()) {
      for (const entry of list) {
        if (new Date(entry.next_review_at) <= this.clock()) {
          effects.push({ type: "EMERGENCY_REVIEW_DUE", relationshipId: entry.relId });
        }
      }
    }

    this.vault.purgeExpired();
    this.clock = saved;
    return effects;
  }

  // 测试/审计辅助：重放事件链验证未被篡改。
  verifyChain() {
    return this.log.verify();
  }

  validate(record) {
    return validateEvent(record);
  }
}
