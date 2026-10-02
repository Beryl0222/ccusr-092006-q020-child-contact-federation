# 儿童联系人跨品牌互通服务

面向多家儿童手表厂商的窄通路联系人互通：家长先建立真实关系，学校证明或面对面短码只负责**一次相识**，能力按年龄段分别开放，跨品牌只交换完成联系所需的最少标识。服务**不提供陌生人搜索**，也不向广告/画像系统开放任何数据。

## 设计承诺

1. **窄通路相识**：建立跨品牌联系必须先核销一次性相识凭证——面对面短码（10 分钟）、学校证明（30 天）或监护人引荐（7 天），凭证核销后不可复用。
2. **四重门**：双方孩子确认 + 双方监护人同意，在 7 天请求期限内全部完成，关系才成立；任一门未过都给出家长可读的理由。
3. **按龄开放**：能力取双方年龄段交集（低龄一方决定上限）。位置分享没有长期授权，只有逐次发起、最长 60 分钟的限时会话。
4. **离线幂等**：加友请求带幂等键，手表离线重发返回同一条关系，绝不重复建关系、不重复核销凭证。
5. **撤销与缓存**：撤销/终止立即下发缓存失效指令，各方承诺 24 小时内失效并逐品牌收回执；逾期未回执会被明确标记，不会被默认成已失效。
6. **连续处理路径**：设备换绑（15 天）、监护权改变（30 天宽限）、账号跨品牌迁移（14 天重新确认）、品牌退出联盟（90 天过渡）、紧急联系人例外（24 小时）都有明确状态、期限与恢复/终止出口。
7. **可解释**：`explain()` 返回状态、中文理由、剩余期限与逐项能力说明，家长能读懂一段联系为什么被允许或阻断。
8. **证据另封**：安全投诉证据进入目的受限、访问全程登记、180 天到期销毁的证据封存库（`EvidenceVault`），与联系数据流物理隔离。
9. **最小标识**：跨品牌联系人视图只含 `federation_pseudonym / brand_id / age_band / intro_ref / display_label`；没有真实姓名、生日、设备号、学校班级、通讯录等字段，迁移与撤销时假名可轮换。
10. **不暴露他人的申诉**：跨品牌申诉仅凭对方假名+品牌即可发起，接口不接受也不回传其他儿童资料。

## 年龄段与能力

| 年龄段 | 文字 | 语音 | 位置（逐次限时） | 群组 |
| --- | --- | --- | --- | --- |
| 0-7 | – | – | – | – |
| 8-11 | ✓ | – | – | – |
| 12-15 | ✓ | ✓ | ✓（单次≤60 分钟） | ✓ |
| 16-17 | ✓ | ✓ | ✓（单次≤60 分钟） | ✓ |

跨品牌只交换粗粒度年龄段，不交换出生日期。

## 期限一览（集中在 `src/policy.js`）

| 事项 | 期限 | 逾期后果 |
| --- | --- | --- |
| 面对面短码 | 10 分钟 | 凭证失效，需重新当面生成 |
| 学校证明 | 30 天 | 凭证失效 |
| 监护人引荐 | 7 天 | 凭证失效 |
| 加友请求（双向确认+双方同意） | 7 天 | 请求终止 |
| 设备换绑 | 15 天 | 换绑申请失效，沿用旧设备、关系恢复 |
| 监护权改变宽限 | 30 天 | 新监护人未重新确认则关系终止 |
| 账号迁移重新确认 | 14 天 | 关系终止 |
| 品牌退出过渡期 | 90 天 | 跨品牌关系终止，标识要求删除 |
| 紧急联系人例外 | 24 小时 | 临时通道自动关闭 |
| 单次位置会话 | ≤60 分钟 | 自动关闭 |
| 撤销后缓存失效 | 24 小时（承诺） | 未回执方被标记逾期 |
| 申诉处理 SLA | 7 天 | — |
| 证据封存 | 180 天 | 到期销毁 |

## 目录

- `src/domain.js`：事件种类、关系状态、介绍方式、能力、阻断理由码、最少标识白名单。
- `src/policy.js`：期限常量、年龄段能力交集、家长可读理由文案。
- `src/evidence_vault.js`：证据封存库（目的限制、访问日志、哈希链、到期销毁）。
- `src/federation_service.js`：互通状态机与全部业务操作。
- `src/child_contact_federation.js`：旧入口的兼容再导出。
- `data/sample.json`：虚构事件样例（仅格式核对）。
- `tests/contract.test.js`：覆盖全部承诺的契约测试（30 个）。

## 主要接口

```js
const service = new ChildContactFederation();           // 可注入 { now } 时钟
service.enrollBrand("brand-x");
service.enrollChild({ childId, brandId, ageBand, guardianIds, displayLabel });

service.issueIntroProof({ kind, childIdA, childIdB, issuedBy });
service.requestFriend({ fromChildId, introCode, idempotencyKey }); // 幂等
service.childConfirm({ relationshipId, childId });
service.guardianConsent({ relationshipId, guardianId, decision }); // false = 撤回

service.canUseCapability({ relationshipId, childId, capability });
service.startLocationSession({ relationshipId, childId, ttlMs }); // 上限 60 分钟

service.revokeRelationship({ relationshipId, guardianId });
service.ackCacheInvalidation({ relationshipId, directiveId, brandId });
service.cacheStatus(relationshipId);

service.startDeviceRebind / completeDeviceRebind
service.startGuardianshipTransfer / reaffirmGuardianship
service.startAccountMigration / migrationChildReconfirm / migrationGuardianConsent
service.declareBrandExit / sweepTimeouts                // 定时扫描所有到期事项
service.declareEmergencyContact / markEmergencyNoticeDelivered

service.fileComplaint({ reporterGuardianId, childId, relationshipId|aboutPseudonym+aboutBrandId, category, evidence });
service.complaintStatus(complaintRef, guardianId);      // 只返回自己的申诉与最少标识
service.resolveComplaint(ref, { outcome });             // UPHELD 撤销 / DISMISSED 恢复

service.explain(relationshipId);                        // 家长可读解释
service.minimalContactView({ relationshipId, viewerChildId });
```

阻断理由码（如 `INTRO_REQUIRED`、`AGE_GATE_BLOCKED`、`DEVICE_REBIND_PENDING`、`BRAND_EXIT_NO_NEW`、`MIGRATION_PENDING_RECONSENT`、`EMERGENCY_ONLY` 等）与中文文案均定义在 `src/domain.js` / `src/policy.js`，新增对外文案应先加理由码。

## 本地核对

```bash
npm test
```

所有数据均为虚构样例，仓库不含真实个人信息、生产连接或外部账号。
