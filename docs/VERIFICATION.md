# 구현 검증 및 수정 기록

## 2026-10-25 자체 Node 영역 계약 강화와 Kilo 실제 무인 검증

실제 모델 실행 코드는 `6c40ebbfa16569f8353dcf21dd0d141a0cb0823e`, 실행 종료 후 진단·네이티브 읽기 호환성 보완 코드는 `4716c1d36b26f360ff2f57a5c6e12e553d9798c3`이다. 새 자율 npm 계약은 자체 Node 영역별 파일·필수 case·보호된 결함 adapter를 요구한다. 제공 인수 검사를 제외한 복사본에서 baseline·무결함 대조군·제품 결함의 실제 ERR_ASSERTION을 검사하고, 현재 소스/테스트 해시·실제 native 명령·영역별 판단을 결합한다. 검토와 최종 승인은 자체 파일 및 품질 보고서의 완료된 native 읽기도 요구한다. 기존 필드 없는 그래프·저장 버전·REST/SSE는 유지했다.

실제 Kilo Auto Free 세션 `f570c4e3-2032-434f-b433-1ae9824366ff`는 **2026-10-25 03:27:33–04:27:33 KST, 60분 / CLI 8회** 후 전체 시간 예산 소진으로 **PAUSED**다. 목표/설정/예산 변경·승인·재개·워크플로 STOP·운영자의 대상 코드 수정은 모두 0회였다. 요청 모델은 계속 `kilo/kilo-auto/free`이고 native 무료 판정에 따른 추가 복구 1회를 사용했다. 실제 계정 청구액은 측정하지 않았다.

| 범위 | 결과 |
|---|---|
| 실제 자체 Node | 4영역 필수 25개·제품 결함 12개, 품질 8회 중 2회 통과 이력. 후속 game/app 수정으로 최종 소스 해시와 보고가 불일치하며 현재 유효한 Test PASS는 없음 |
| 실제 독립 검사 | 엔진 13묶음/4000비교, 컨트롤러·저장 최종 12/12, 실제 Chromium 최종 4/4. 각 시점의 결과이며 최종 승인 아님 |
| 미완료 | 플랫폼 브라우저 39단계, 수락된 정식 테스트 PASS, 읽기 전용 검토, 최종 승인 모두 미도달 |
| 차단·정리 | 테스트 attempt의 fileMutation=true 보존, 전역 성공 게이트 불충족. 고정 6개 파일 유지. 관측 PID 215개 종료·포트 12개 폐쇄·소유 잔류 0, PAUSED 유지 |
| 보완 코드 로컬 회귀 | Node 24.21.0 macOS arm64: 코어 258 통과 / Windows ConPTY 전용 1 제외 / 실패 0; GUI 25/25, 도구 10/10, 실행기 4/4 |
| 패키지·실패 probe | 72파일·새 설치 smoke 통과, 운영 audit 0건. 의도된 HTTP 정리 누락은 exit 1과 timeout/정리 안내 유지, worker 3개 종료 확인 |

새 계약은 초기의 타입 확인 중심 컨트롤러 테스트와 HTTP 실패 경로의 서버 정리 누락을 실제로 차단했다. Kilo가 자체 assertion·raw HTTP·정리를 보완했으나 이후 테스트 역할에서 제품 수정이 이어지고 전체 예산이 소진됐다. 과거 Node 통과 출력과 최신 소스의 유효한 증거를 구분하며 이 실행을 SUCCESS 또는 완전 무인 운용 안정성의 증거로 취급하지 않는다. 빈 assertion을 거부한 뒤 자동 보완·독립 검토·최종 승인까지 가는 경로는 fake CLI/실제 Node 검증기 회귀에서 별도로 통과했다.

`4716c1d`는 큰 보고서의 출력 절단에 대비한 요약/원인 안내와 단독 exit-zero Kilo/OpenCode shell 읽기를 보완했다. 이 코드로 실제 모델을 재실행하지 않았으며 전체 로컬 회귀·설치·실패 probe와 실제 로그 재생만 수행했다. Windows/Linux 신규 원격 CI·push·main 병합은 수행하지 않았다. [기준 main CI](https://github.com/youwonsock/custom-agent-loop-system/actions/runs/40105004387)는 이번 코드의 검증 결과와 별도다.

[바탕화면 상세 보고서](</Users/supercent/Desktop/agent graph test/kilo-node-contract-20261025-025134/TEST_RESULTS.md>) · [기계 판독 결과](</Users/supercent/Desktop/agent graph test/kilo-node-contract-20261025-025134/RESULTS.json>)에 실제 세션/로그·품질 실패와 통과 이력·Chromium 스크린샷·고정 해시·정리 근거·개발자 calibration/probe를 구분해 보존했다.

## 2026-10-25 완료 프로토콜·검사 종료코드·write 복구 수정과 Kilo 실제 무인 완주

실제 검증 코드 `819f96b3cf599ce6bb6a075654bd0321dcc295c6` (`codex/autonomous-protocol-recovery`), main 기준 `f41b3974a3470424d36da37ede43eed22c4df6ac`. 자율 구현의 평문 마지막 인라인 표식만 제한 정규화하고 원시 응답을 보존한다. 등록 Kilo 검사의 표시용 파이프/상태 echo는 native 실행 전에 정확한 등록 명령으로 교체하되 기존 bash 권한 검토와 엄격한 receipt 게이트는 유지한다. write 스키마 오류 2회 뒤에는 유효 에이전트의 write/edit 도구를 호출별 설정에서 제외하고 허용된 bash로 이어간다. 전역 CLI 설정·모델·공개 API·저장 형식·의존성 버전은 유지했다.

실제 Kilo Auto Free 세션 `9933be52-2234-4cc1-8faa-2286736f53e0`는 **2026-10-25 02:01:09–02:32:15 KST, 31분 06.8초 / 10회**로 제작 → 정식 테스트 PASS → 읽기 전용 검토 APPROVED → 최종 승인 APPROVED → SUCCESS에 도달했다. 최초 60분/24회 예산을 유지했고 승인·재개·피드백·소스 수정·예산 변경 0회였다. 요청 모델은 `kilo/kilo-auto/free`이며 무료 복구 직전 native isFree=true를 재확인했다. 계정 청구액은 측정하지 않았다.

| 검사 | 결과 |
|---|---|
| 실제 표식·종료코드 | 원문 `All checks pass. [PHASE_DONE]` 정규화, 정식 테스트 역할의 등록 명령 5개 exit 0, 이전 실제 실패 exit 1 네 건 보존 |
| 실제 게임 | 모델 자체 엔진 smoke 3/3, 고정 엔진 13묶음/4000비교, 상태 12/12, 실제 Chromium 4/4, 브라우저 39단계 통과; 고정 5개 파일·최종 소스 해시 유지 |
| 로컬 Node 24 코어·서버·CLI | 247 통과 / Windows ConPTY 전용 1 제외 / 실패 0 |
| Chromium GUI / 도구 / macOS 실행기 | 25/25 / 10/10 / 4/4; 타입·빌드·CLI smoke 통과 |
| 패키지 / 운영 audit | 새 설치본의 native 훅·write 복구·기존 기능·보안 smoke 통과, 취약점 0 |
| 종료 | 소유 관찰 프로세스 17개 종료, 포트 8개 폐쇄, 잔류 0; SUCCESS 유지·워크플로 STOP 0회 |

코어/GUI 전체 회귀 커밋은 `1153ba980918164d22ead2dd25fff8829c5b390b`이며 이후 `819f96b`는 패키지 검사 2개만 보강했고 런타임 소스는 동일하다. 새 패키지 검사는 `819f96b`에서 통과했다. 개발 중 fixture의 설정 조회 미지원 실패도 보존하고 수정 후 전체 회귀를 다시 통과했다.

실제 공급자 오류 로그 14건과 계획 형식 보완 2회가 있었고 무료 추가 복구 1회로 완주했다. write 인수 오류는 실 실행에서 0건으로, 해당 대체 경로는 회귀·실제 Kilo 설정 probe에서만 확인했다. 모델 자체 Node 3개는 엔진 smoke에 국한되며 컨트롤러/저장/HTTP의 자체 테스트 작성 폭은 추가 개선 대상이다. 한 번의 고정 계약 완주와 일반 작업의 가용성·테스트 설계 품질을 구분한다.

새 커밋의 Windows/Linux 원격 CI·main 병합·push는 이번 요청에서 수행하지 않았다. [기준 main CI](https://github.com/youwonsock/custom-agent-loop-system/actions/runs/40105004387)는 이번 모델 실행과 별도다. [바탕화면 보고서](</Users/supercent/Desktop/agent graph test/kilo-protocol-recovery-20261025-014350/TEST_RESULTS.md>) · [기계 판독 결과](</Users/supercent/Desktop/agent graph test/kilo-protocol-recovery-20261025-014350/RESULTS.json>)에 원시 로그·실패/성공 이력·스크린샷·정리 근거를 보존했다.


## 2026-10-24 Windows·Linux·macOS 원격 CI 통과와 main 반영

병합 전 검증 커밋: `d545169f686599cf4915f396ddb031505b6c3c89`. [GitHub Actions CI #73](https://github.com/youwonsock/custom-agent-loop-system/actions/runs/40104250854)의 Windows·Ubuntu·macOS 플랫폼과 Ubuntu Chromium 작업 4개가 모두 success다. 각 작업은 깨끗한 체크아웃에서 Node 24.21.0 / npm 11.19.0으로 실행됐다.

| 원격 검사 | 결과 |
|---|---|
| Windows x64 코어·서버·CLI | 241 통과, 제외 0, 실패 0; 실제 ConPTY 검사 포함 |
| Linux x64 코어·서버·CLI | 240 통과, Windows ConPTY 전용 1 제외, 실패 0 |
| macOS arm64 코어·서버·CLI | 240 통과, Windows ConPTY 전용 1 제외, 실패 0 |
| 개발 도구 / macOS 실행기 | OS별 도구 10/10; macOS 실행기 4/4와 빌드 통과 |
| Chromium GUI | 25/25; 초기 JavaScript 449,118 / 500,000 bytes |
| 패키지 내용·새 설치·운영 audit | 세 OS 모두 통과; 설치 의존성 보안 재현 통과, 운영 취약점 0 |

Windows에서 발견된 PTY 마스킹 실패는 재조립한 JSON 이벤트를 저장하기 전에 다시 마스킹하도록 수정했고, 줄바꿈으로 분리된 비밀값의 결정적 재현 검사를 추가했다. 서버 회귀의 직접 런타임 실행은 운영 worker 경로로 격리해 Windows ConPTY 핸들 때문에 테스트 프로세스가 남지 않도록 했다. 기존 판정 assertion과 Windows 네이티브 검사는 유지했다. 개발 테스트 출력은 TAP으로 바꿔 실패 상세를 즉시 보존한다. 공개 CLI·REST/SSE·저장 버전은 변경하지 않았다.

처음 실행한 [CI #71](https://github.com/youwonsock/custom-agent-loop-system/actions/runs/40103108271)은 Windows 마스킹 실패와 종료 지연을 확인한 뒤 중단했고, [CI #72](https://github.com/youwonsock/custom-agent-loop-system/actions/runs/40104060716)는 후속 격리 수정으로 대체했다. 두 실행을 최종 통과 수에 합산하지 않는다. 로컬 빌드가 겹쳐 무효화한 실행과 수정 전 보안 재현 실패도 별도로 보존했다. 최종 커밋의 로컬 플랫폼·GUI는 순차 재검사하여 모두 통과했다.

원격 artifact는 OS·커밋·실행 회차별로 90일 보존하며 바탕화면에도 ZIP과 원시 요약·로그·스크린샷을 내려받아 SHA-256을 검증했다. 성공한 35개 커밋의 이력을 fast-forward로 main에 반영했으며, 이 검증 기록을 제외한 소스는 위 검증 커밋과 같다. 원격 main 갱신과 main에서 재실행한 CI의 최종 결과는 [바탕화면 보고서](</Users/supercent/Desktop/agent graph test/ci-main-merge-20261024-233356/TEST_RESULTS.md>) 및 [기계 판독 결과](</Users/supercent/Desktop/agent graph test/ci-main-merge-20261024-233356/RESULTS.json>)에 기록한다.

실제 모델 추론은 이번 CI에서 실행하지 않았다. 공급자 기능은 fake CLI fixture로 검사했으며 실제 HTTP·Chromium·npm 설치 검사는 구분한다. 로컬 테스트 서버와 설치 임시 경로 정리를 확인했다. 이전 실제 Kilo 결과와 과거 실패 기록은 보존한다.

## 2026-10-24 의존성 취약점 수정과 전체 설치 회귀

검증한 코드·lockfile·검사 커밋: `fe08bf2c9e8e1aff3270146f7a63ee93e4414747` (`codex/verified-completion`). Node 24.21.0 / npm 11.19.0 / macOS arm64의 깨끗한 커밋 상태에서 `verify:platform`과 `verify:browser`를 순차 실행했고 모두 exit 0이다. 이후 변경은 이 검증 기록뿐이다.

- 운영 의존성 audit의 high 1(body-parser), moderate 1(fast-uri)을 해소했다. `body-parser 2.3.0 → 2.4.0`, SDK/MCP/Ajv의 `fast-uri 3.1.8 → 3.1.9`, Fastify의 두 소비 경로는 `4.2.2 → 4.2.3`으로 갱신했다. body-parser가 요구하는 `qs 6.16.0 → 6.16.1`을 포함해 lockfile의 패키지 경로 5개만 바뀌었으며 package.json·직접 의존성 버전은 유지했다.
- 기존 fast-uri의 인코딩된 scheme 우회와 body-parser의 압축 요청 뒤 추가 데이터에 의한 프로세스 종료를 실제 재현했다. 수정 후 URI 소비 경로 3개와 gzip/deflate/br 요청·정상 JSON·공격 후 health 검사를 통과했다. 보안 검사는 개발 도구 suite와 새로 설치한 배포 패키지의 실제 의존성 모두에 적용하며 검사 fixture는 배포에 포함하지 않는다.
- 별도 쓰기 가능한 npm 캐시로 `npm ci`를 성공시켰다. 취약점 숨김·audit 제외·강제 major 업데이트 없이 수정했으며 공개 API·저장 형식·실행 정책은 변경하지 않았다.

| 검사 | 결과 |
|---|---|
| 운영 / 전체 의존성 audit | 각각 high 0, moderate 0, low 0, 전체 취약점 0 |
| 코어·서버·CLI | 239 통과, Windows ConPTY 전용 1 제외, 실패 0 |
| 개발 도구 / macOS 실행기 | 10/10(보안 회귀 2개 포함) / 4/4; 실행기 빌드 통과 |
| Chromium GUI | 25/25; 기존 자동 복구·계획/승인·화면 상태 보존·SSE·지연 로딩 복구 포함 |
| 초기 그래프 JavaScript | 449,118 / 500,000 bytes |
| 타입·빌드·CLI smoke | 모두 통과 |
| 패키지 내용·새 설치 smoke | 64개 파일; 실제 tarball 설치, CLI·모든 웹 청크·workspace·네 공급자 fixture API·보안 검사·정상 종료 통과 |
| 정리 | 보안 probe PID 3개·해당 포트 종료, GUI 포트 4379 폐쇄, 설치 임시 경로 제거 확인 |

원시 audit·의도된 취약 버전 재현 실패·최종 검사 명령/시간/종료 코드·로그·화면 14개·설치 의존성 버전·정리 근거는 [바탕화면 보고서](</Users/supercent/Desktop/agent graph test/dependency-audit-20261024-231300/TEST_RESULTS.md>)와 [기계 판독 결과](</Users/supercent/Desktop/agent graph test/dependency-audit-20261024-231300/RESULTS.json>)에 보존했다. 관련 공식 공지는 [body-parser](https://github.com/advisories/GHSA-27r3-jxmh-p828), [fast-uri scheme](https://github.com/advisories/GHSA-w74x-v6f9-j3xg), [host](https://github.com/advisories/GHSA-wjr9-j795-jxcr), [relative path](https://github.com/advisories/GHSA-xhq7-xmqj-769h), [suffix](https://github.com/advisories/GHSA-333x-w4r6-6crp)다.

이번 실행은 fake CLI 기반 제품 회귀와 실제 HTTP/Chromium·패키지 설치 검사다. 실제 모델 추론 및 Windows/Linux 원격 CI는 재실행하지 않았으며 새 Actions 링크와 원격 push는 없다. 아래 과거 기록의 audit 실패는 당시 결과로 보존한다.

## 2026-10-24 고정 검증 계약·전체 예산 개선과 Kilo 실제 무인 완주

실제 검증 코드 커밋: `bd51f91cad036a5bb828e83b02638fcca4b10c3f` (`codex/verified-completion`, 시작 시 깨끗한 상태). 구현은 `7de0a45` → `d819185` → `2c8e724` → `128971c` → `bd51f91`로 나누고, 이후 변경은 검증 문서다. 정책·형식은 [AUTONOMOUS_WORKFLOW.md](AUTONOMOUS_WORKFLOW.md)에 기록했다.

- 보호 인수 파일과 manifest를 SHA-256으로 고정하고 모든 고정 요구사항 및 등록 검사 전부의 실제 성공을 요구한다. 테스트·검토·최종 승인은 JSON v1 판단을 제출하며 엔진이 실제 native receipt를 연결한다. 기존 그래프/세션 형식과 명시적 사용자 승인·네이티브 권한 정책은 유지한다.
- 새 실행 기본 전체 예산은 60분·에이전트 CLI 24회다. 보고 보완·무료 복구·재개·재시작으로 초기화하지 않으며 모델 조회·승인 대기에도 적용한다. 이 호출 수는 공급자 내부 API 요청·토큰·금액 예산이 아니다.
- 실제 검증 중 발견한 공백 경로·정규식의 파일 접근 오인, 동일 대상 cd 명령의 오판, npm script 실패 마스킹, 상태코드 없는 Service Unavailable 분류를 수정했다. 목표에 없던 외부 경로를 계획이 추가하면 유한 보완하고, 원래 사용자가 명시한 외부 경로는 기존 승인 절차를 유지한다.

| 검증 | 결과 |
|---|---|
| 코어/서버/CLI | 239 통과, Windows ConPTY 전용 1 제외, 실패 0 |
| Chromium GUI | 25/25; 초기 JS 500kB 제한·상태 보존·실패 복구 포함 |
| 타입/빌드/개발 도구/macOS 실행기 | 통과; 도구 8/8·실행기 4/4 |
| 패키지 내용·설치 smoke | 64개 파일, 설치·CLI·웹 청크·모델 API smoke·종료 통과 |
| 실제 Kilo Auto Free | 2048 제작 → 테스트 PASS → 읽기 전용 검토 APPROVED → 최종 APPROVED → SUCCESS |
| 실제 모델 실행 시간/예산 | 22:11:41–22:59:24 KST, 47분 43.4초, CLI 17/24회; 원래 60분 마감 유지 |
| 생성 게임 | 자체 Node 37/37, 고정 엔진 13개 묶음/4,000 비교, 상태·저장 12/12, 실제 Chromium 4/4, 브라우저 명세 39/39 |
| 최종 실행 운영자 개입 | 승인·재개·피드백·대상 수정 0; 완료 후 워크플로 STOP 0 |
| 무결성·정리 | 고정 파일 5개 유지, 필수 검사 5개 실제 exit 0, 현재 브라우저 소스 해시 일치, 소유 프로세스 0·관측 PID/포트 각 10개 종료 |
| 운영 의존성 audit | 실패: high 1(body-parser), moderate 1(fast-uri); 의존성 버전/lockfile 변경 없음 |

실제 세션은 `6d9fc9a6-78e8-494c-92f5-297f61545869`, 요청 모델은 `kilo/kilo-auto/free`(Kilo 7.4.23), 플랫폼은 macOS arm64 / Node 24.21.0이다. 네이티브 공급자 오류 39개와 반복 오류 차단 5건을 보존했고, 계획·구현·테스트 방문이 각각 무료 자동 복구 1회를 사용했다. 구현 중의 빈 Node suite는 테스트 역할이 37개로 보완했다. 최종 고정 검사 5개는 테스트 역할에서 개별 실행했다. 사전 제공한 acceptance fixture/spec/manifest를 모델이 새로 설계했다고 주장하지 않는다.

앞선 진단 4건(접근 대기 2건·플랫폼 수정을 위한 운영자 중단 2건)은 최종 무인 성공에 합산하지 않는다. 원시 로그·최종 상태·실패 이력·스크린샷·trace·해시·정리 근거는 [로컬 보고서](</Users/supercent/Desktop/agent graph test/kilo-autonomy-contract-20261024-220923/TEST_RESULTS.md>)와 [기계 판독 결과](</Users/supercent/Desktop/agent graph test/kilo-autonomy-contract-20261024-220923/RESULTS.json>)에 보존했다. 실제 모델 실행과 fake CLI 기반 제품 회귀는 구분한다.

새 Windows/Linux 원격 CI와 반복 장기 운영은 이번 변경에서 실행하지 않아 새 Actions 링크가 없다. audit 실패를 포함해 전체 검사 전부가 성공했다고 기록하지 않는다. 단일 실제 무인 성공으로 공급자 가용성·도메인 oracle 충분성·범용 장기 안정성을 보장하지 않는다. 원격 push는 수행하지 않았다.

## 2026-10-24 자율 실행 경로 개선

제품·테스트 커밋 `e3b98c55285afd69060411ba978a977237127a77`의 깨끗한 상태에서 Node 24.21.0 / macOS arm64로 검증했다. 사용 방법과 정책은 [AUTONOMOUS_WORKFLOW.md](AUTONOMOUS_WORKFLOW.md)에 기록했다.

- 자율 프리셋은 계획 1개 자동 선택, 제한된 실패 수정(기본 3회), 선택적 실제 브라우저 증거 강제를 제공한다. 기존 수동 계획·접근 승인·STOP·무료/유료 복구 한도는 유지한다.
- 테스트의 product/test_setup BLOCKED는 자율 실행에서 실패 경로로 돌리고, 제품 변경은 네이티브 경로와 전후 해시로 반려한다. 실제 권한·인증·사람 증거는 대기한다. 형식 보완은 현재 네이티브 기록의 유무·성공/실패에 따라 처리한다.
- 플랫폼 verify-browser가 실제 생성 서버·Chromium·DOM/입력/저장 assertion을 실행하고 실행별 로그·화면·trace·해시를 보존한다. 실제 성공 명령이 없으면 보고서만으로 통과하지 않는다. 소스 변경·취소·브라우저 미설치·정리 불확실은 성공으로 승격하지 않으며 외부 서버를 재사용/종료하지 않는다.
- Codex 명령별 네이티브 자동 승인 검토를 쓰기 역할에만 opt-in으로 연결하고 Node 경로를 자식 환경에 고정했다. 사용자 전역 승인 정책은 바꾸지 않는다. 그래프 v2의 선택적 automation 필드와 개발 CLI 명령만 추가했으며 기존 세션 v3는 그대로 읽는다.

| 검사 | 결과 |
| --- | --- |
| 코어·서버·CLI | 201 통과, Windows ConPTY 전용 1 제외, 실패 0 |
| Chromium GUI | 25/25; 기존 20개와 자율 기능 5개 포함 |
| 실제 자율 흐름 | 결정적 CLI fixture + 실제 Chromium·생성 서버. 가로 넘침 FAIL → 자동 구현 수정 → 실제 재검사 PASS → 읽기 전용 검토·최종 승인 → SUCCESS, 운영자 제어 요청 0 |
| 기존 실제 모델 산출물 복사본 | Luna/Kilo 각각 새 검증기로 37단계 통과; 원본 소스와 동일, 서버 자동 종료 |
| 타입·빌드·개발 도구·macOS 실행기·패키지 내용/설치 | 통과 |
| 초기 그래프 JavaScript | 448,199 / 500,000 bytes |
| 운영 의존성 audit | 실패: high 1, moderate 1 (body-parser, fast-uri); 종합 verify:platform 종료 코드 1 유지 |

package.json·lockfile은 기존 `9530dec`와 같다. 의존성 버전은 변경하지 않았으며 기존 lockfile에 보고되는 취약점 때문에 전체 검사가 모두 통과했다고 기록하지 않는다. 실제 모델의 새 무인 추론 실행과 Windows/Linux 원격 CI는 이번 변경에서 미실행이며 새 Actions 링크도 없다. 앞선 실제 모델의 운영자 보조 완주와 이번 결정적 무인 오케스트레이션 검증은 구분한다.

증거: `/Users/supercent/Desktop/agent graph test/autonomy-hardening-20261024/TEST_RESULTS.md`, `OPERATOR_INTERVENTION_ANALYSIS.md`, `RESULTS.json`, 최종 suite 요약·로그·실패 이력·fixture 상태·브라우저 보고서/trace와 정리 확인. 생성한 서버와 worker lease 종료를 확인했고 원격 push는 수행하지 않았다.

## 2026-10-24 실제 제작 재검증 완료

제품·회귀 검사 커밋: `c66a916077ceffc0f6e5e43bdea583a55e1c3e21` → `9cfcda6dfcb95bb39b26e6d81b489b925dade5d1` (`codex/verified-completion`). 아래 실제 실행은 2026-10-24 KST에 완료했고 이후 변경은 검증 문서다.

- Codex 로그인 셸을 끄고 실행 중인 Node 디렉터리를 자식 PATH 앞에 고정했다. 명시적인 upstream 라우팅 `Invalid credential`은 실제 401/403이 없는 경우만 연결 장애로 처리하며 새 네이티브 세션으로 제한 재시도한다. 일반 인증 실패와 기존 비용·시간 한도는 유지한다.
- 전경 단일 검사 명령과 독립 행 CHECK_COMMAND를 안내하고 백그라운드 `&`·파이프·종료 상태 래퍼를 성공 근거에서 제외한다. 검토·최종 승인·계획·중단 분석 역할은 테스트/서버를 실행하지 않고 현재 테스트 역할의 네이티브 종료 코드를 확인한다.
- 이전 게임의 결함은 별도 `repaired-baseline` 복사본에서 수정·검사했다. 새 빈 폴더에서 두 요청 모델이 각각 2048을 제작하고 저장값 경계·상태 복원·저장소 거부·공백 경로 서버·실제 HTTP·포인터·격자/모바일/접근성 문제를 수정했다. 새 게임의 제품 파일은 모델이 수정했으며 운영자는 독립 검사와 피드백·브라우저 보고서를 작성했다.

| 실제 모델 실행 | 최종 상태와 근거 |
| --- | --- |
| 요청 `gpt-6-luna` | 제작 → 테스트 PASS → 검토 APPROVED → 최종 APPROVED → SUCCESS. 모델 전체 검사 11/11, 독립 엔진 13개 묶음/4,000 비교, 상태·저장 13개, 실제 IAB 11개 통과 |
| 요청 `kilo/kilo-auto/free` | 같은 전체 경로로 SUCCESS. 모델 전체 검사 24/24, 독립 엔진 13개 묶음/4,000 비교, 상태·저장 13개, 실제 IAB 11개 통과 |

각 최종 `successBlockers`는 빈 배열이며 운영자가 발급한 브라우저 보고서 원본과 현재 root 소스 6개 해시가 일치한다. 이 예제의 `npm test`가 보고서·해시를 직접 검증한다. 테스트 명령 뒤 echo 래퍼를 덧붙인 실행, 필수 브라우저 보고서 누락, 테스트 역할이 CSS를 수정해 보고서 해시가 달라진 실행은 모두 성공으로 수락하지 않았다. 수정 후 실제 브라우저 재검사와 새로운 네이티브 테스트 종료 코드 0을 확보한 뒤 최종 승인에 도달했다.

macOS arm64 / Node 24.21.0 제품 회귀: 코어 186 통과, Windows ConPTY 전용 1 제외, 실패 0; 개발 도구 8/8; macOS 실행기 4/4; 타입·빌드·패키지 내용/설치 smoke 통과; 운영 audit 취약점 0. 마지막 프롬프트 수정 후 코어 전체를 재실행했다. 두 생성 게임 전체 suite도 운영자 Node 24에서 각각 11/11·24/24를 별도 확인했고 소스 불변을 검사했다. 제품 Chromium GUI 20개 전체 suite와 Windows/Linux 원격 CI는 이번 변경에서 재실행하지 않았으며 새 Actions 링크는 없다. 제품 코어의 fake CLI 회귀와 위 실제 모델 실행은 구분한다.

계획 승인, 구체적 결함 피드백, 수동 재개와 운영자 브라우저 증거 발급이 포함된 보조 검증이다. 최종 승인은 그래프 approval 역할의 실제 모델 판정이다. 승리/게임 오버·저장값 경계는 결정적 controller 검사이며 저장소 getter 거부의 fake DOM 검사는 실제 브라우저 검사와 구분한다. 물리 터치·장기 부하는 미검증이다. Codex는 실제 모델 ID를 보고하지 않아 요청 ID만 확인했고 Kilo 라우팅 ID는 결과 JSON에 별도 보존했다. 무료 메타데이터는 실제 청구 보장이 아니다.

Luna 쓰기 역할은 세션 전용 래퍼의 네이티브 명령별 자동 승인 검토(`--approve-for-me`)로 정확한 테스트 명령을 실행했고 workspace-write를 유지했다. 감사 역할은 read-only이며 사용자 전역 설정·인증을 변경하지 않았다. 테스트 서버·자식 프로세스·세션 lease 종료와 포트 폐쇄를 확인했고 두 SUCCESS를 보존했다. 원격 push는 수행하지 않았다.

증거: `/Users/supercent/Desktop/agent graph test/hardening-live-20261024-020347/TEST_RESULTS.md`, `RESULTS.json`, `results/final-evidence.json`, `results/cleanup-final.json`, 실제 네이티브 세션 로그와 실패/재검사 화면. 이전 실행 폴더는 보존했다. 사용자 홈의 인증·세션 파일은 복사하지 않았다.

## 2026-10-24 구조 개선·실패 증거 보존

검증한 제품·테스트 커밋: `d8221cb54560292fd1eb1c396613cec54bd80d65` (`codex/verified-completion`). macOS arm64 / Node 24.21.0 / npm 11.12.1의 깨끗한 커밋 상태에서 최종 검사를 순차 실행했다. 이후 변경은 문서 갱신이다.

- 검토·최종 승인 역할의 실패/미완료 검사도 APPROVED를 막는다. 환경 차단은 대기하고, 형식 보완 재시도에서도 실패 근거를 보존한다. 새 구현·테스트·승인을 통과한 경우만 성공한다.
- 세션 저장 순번으로 오래된 runtime 쓰기와 지연 SSE의 상태 역전을 거부한다. 완료 세션은 변경될 때만 상세 JSON을 읽고, UI 목록은 요약·선택 세션은 상세 조회한다. 기존 기본 REST/SSE 응답은 유지한다.
- 상태 전이·저장 schema·공급자 이벤트·프로세스 유틸리티를 분리했다. version 3 손상 데이터는 원본을 보존하며 거부하고 선택 필드 없는 기존 기록은 계속 읽는다.
- 화면/hook 의존성을 제한하고 그래프 속성/실행 입력을 추출했다. 서버와 UI는 같은 그래프 진단을 사용한다. 상태 소유자와 CSS·localStorage 키는 유지한다.

| 검사 | 확인 결과 |
| --- | --- |
| Node 24 코어·서버·CLI | 180 통과, Windows 전용 1 제외, 0 실패 |
| 개발 도구 / macOS 실행기 | 8/8 / 4/4, 실행기 빌드 통과 |
| Chromium GUI | 20/20; 닫힌 순환 차단 추가, 기존 19개 유지 |
| 타입 검사·웹 빌드 | 통과, 초기 JavaScript 446,426 / 500,000 bytes |
| 패키지 내용·설치 smoke / 운영 audit | 54개 파일 정상, 설치 통과 / 취약점 0 |
| 실제 모델 추론 / Windows·Linux 원격 CI | 이번 변경에서는 미실행, 새 Actions 링크 없음 |

단계별 커밋: `3f21ff3` → `109a1b0` → `5b87c19` → `19b1bb8` → `befa912` → `d8221cb`. 각 단계는 Node 25.2.1에서 검증 후 커밋했으며 최종 Node 24 통합 검증으로 다시 확인했다. 화면 추출 첫 타입 검사에서 미사용 import/변수 3개가 실패했고 제거 후 통과했다. 실패 로그와 후속 미실행 상태, 재검사 결과를 모두 보존했다.

증거: `/Users/supercent/Desktop/agent graph test/architecture-refactor-20261024-002215/TEST_RESULTS.md`, `results.json`, 단계별 `summary.json` 및 로그·스크린샷·번들 측정. 단계 원시 요약의 parent HEAD/dirty 상태와 실제 커밋 매핑도 기록했다. 코어·GUI는 fake CLI 네이티브 이벤트 회귀이며 모델 추론이나 장기 부하 검증과 구분한다. 사용자 홈 인증 정보·실제 CLI 원시 로그는 수집하지 않았다.

## 2026-10-24 전역 성공 조건 강제

검증한 제품·검사 커밋: `8bd02a1a39d7f5b2d8d8222b86c1e608832e8cbb` (`codex/verified-completion`). 깨끗한 커밋 상태에서 아래 검사를 순차 실행했다. 현재 규칙은 [EXECUTION_CONDITIONS.md](EXECUTION_CONDITIONS.md)에 기록했다.

- 편집 화면·실행 API에서 구현 단독 완료, 실패 간선의 SUCCESS 연결, 테스트 생략 경로를 차단한다. 초안 저장은 유지한다.
- 종단에서도 필수 REQ 충족, 현재 테스트 방문의 네이티브 성공 명령과 CHECK_COMMAND 일치, 마지막 최종 승인 역할의 정상 APPROVED를 검사한다. 과거 snapshot·실패 경로·수락 정보가 없는 과거 검증은 자동 성공으로 올리지 않는다.
- 성공 조건 미충족은 원인을 보존하고 PAUSED로 끝낸다. 실패 뒤 수동 재개하여 수정·새 테스트·최종 승인을 거치면 성공할 수 있다. 계획·접근 승인, 기존 비용·복구·STOP 정책은 유지한다.
- 내부 attempt 메타데이터만 추가했다. graph v2 / connection v1 / session stateVersion 3, REST/SSE 및 공개 CLI 옵션은 유지했다. 과거 완료 결과를 소급 변경하지 않는다. 이전 검증 전용 그래프의 SUCCESS는 새 전역 조건의 통과 증거가 아니다.

| 검사 | 확인 결과 |
| --- | --- |
| macOS arm64 / Node 25.2.1 코어·서버·CLI | 165 통과, Windows 전용 1 제외, 0 실패 |
| 개발 도구 / macOS 실행기 | 8/8 / 4/4, 실행기 빌드 통과 |
| Chromium GUI | 19/19, 완료 경로 오류·실행 차단 추가 |
| 타입 검사·웹 빌드 | 통과, 초기 JavaScript 443,784 bytes / 500,000 bytes |
| 패키지 내용·설치 smoke / 운영 audit | 46개 파일 정상, 설치 통과 / 취약점 0 |
| 실제 모델 추론 / Windows·Linux·Node 24 CI | 이번 변경에서는 미실행, 새 Actions 링크 없음 |

코어·GUI는 fake CLI 네이티브 이벤트 fixture 회귀다. 실제 GPT-6 Luna·Kilo 실행이나 테스트의 의미적 완전성을 검증한 결과와 혼동하지 않는다. 초기 회귀에서 기존 구현 단독 완료를 가정한 fixture 2건이 실패했고 필수 테스트·승인을 포함하도록 수정했다. 로컬 검증 래퍼 인자 누락 오류도 기록한 뒤 수정하여 순차 검사 전체를 통과했다.

증거: `/Users/supercent/Desktop/agent graph test/verified-success-20261024001015/TEST_RESULTS.md` 및 `checks/summary.json`. 로그·초기 실패·스크린샷·JS 측정·결과 JSON을 함께 보존했으며 사용자 홈 인증 정보나 실제 CLI 원시 로그는 수집하지 않았다. 이후 커밋은 검증 문서만 갱신한다.

## 2026-10-23 무료·유료 모델 재시도 분리

제품 코드와 검사 커밋: `ac97f223dac80fc0c160c53e8669e3dc333a19c1` (`codex/verified-completion`). 성공·실패·보류 조건 전체와 기본 한도는 [EXECUTION_CONDITIONS.md](EXECUTION_CONDITIONS.md)에 기록했다.

- 정상 attempt·시간 한도 이후에는 공급자가 무료로 확인한 모델만 제한된 자동 복구를 예약한다. 유료·미확인은 토큰 사용이 관측되지 않아도 정지한다. 명시적인 공급자 잔액·할당량 소진은 유료·미확인을 즉시 일시정지시킨다.
- 무료 여부는 네이티브 `isFree`와 비용 정보를 교차 확인한다. 기본 0원 값·모델 이름·구독 여부를 무료 근거로 추정하지 않는다. 자동 복구 때 조회를 갱신하며 유료·미확인으로 바뀌면 추가 호출을 막는다.
- 무료 모델도 인증·권한·검사 환경·프로세스 종료 문제와 사용자 STOP, 추가 자동 복구 횟수·그래프 반복 한도를 지킨다. 예약 대기·조회 지연은 다음 복구 주기의 실행 시간을 소모하지 않는다.

| 검사 | 확인 결과 |
| --- | --- |
| macOS arm64 / Node 25.2.1 코어·서버·CLI | 128 통과, Windows 전용 1 제외, 0 실패 |
| Chromium GUI | 18/18, 무료 복구·유료 정지 표시 포함 |
| 타입 검사·웹 빌드 | 통과, 초기 그래프 JavaScript 443,024 bytes / 500,000 bytes |
| 패키지 내용·설치 실행 | 44개 파일 정상, 설치 CLI·웹·네 모델 API·정상 종료 통과 |
| 실제 Kilo 네이티브 모델 조회 | 444개 모델 조회, `kilo/kilo-auto/free` 무료 / `kilo/kilo-auto/efficient` 유료 판정 확인 |
| 실제 모델 추론 / 원격 CI | 이번 변경에서는 미실행, 새 Actions 링크 없음 |

코어·GUI는 fake CLI로 가격 변경, 사용량 발생 후 복구, 횟수·절대 시간 소진, 할당량 소진, 복구 중 STOP을 실행했다. 실제 Kilo 검사는 모델 메타데이터만 조회했으며 실제 추론을 수행하지 않았다. 기존 2048 게임 실행 기록은 아래 이전 검증 결과와 구분한다.

처음에는 종전 비용 정책을 가정한 서버 종료 fixture 1건, 다음에는 동일한 진행 메시지를 반복해 idle timeout을 유발한 시간 한도 fixture 2건이 실패했다. fixture를 새 조건에 맞게 수정한 후 전체 코어·GUI가 통과했다. 기본 npm 캐시 환경의 패키지 검사는 상세 원인 없이 exit 1을 반환했으며 별도 임시 캐시의 내용·설치 검사는 통과했다. 실패 요약·로그와 재검사 결과를 모두 보존했다.

로컬 증거: `/Users/supercent/Desktop/agent graph test/pricing-retry-20261023-232705/TEST_RESULTS.md`. 원시 검증 summary는 검사 당시 이전 HEAD와 dirty 상태를 기록하며, 보고서의 검증 커밋은 동일한 제품·검사 소스를 커밋한 위 SHA다. 이후 변경은 검증 문서뿐이다.

## 2026-10-23 실제 실행 후 완료 판정 보강

제품 코드 `508c7cb519b92927ea91950a127f938895d219e4`, GUI 회귀 추가 `28775e2`를 검증했다. 작업 브랜치는 `codex/verified-completion`이며 원격 CI는 이번 수정에 대해 실행하지 않았다. 이전 Actions 결과는 아래 해당 커밋의 기록으로만 해석한다.

- `4fce808`: HTTP/파일 경로 구분, 공백·Windows 승인 경로 보존, 네이티브 검증 명령/종료 코드 기록, 요구사항 CHECK_COMMAND 연결, 수정 후 증거 무효화, 현재 테스트 PASS에 근거한 검토/승인, 환경 차단 대기.
- `508c7cb`: 실제 Luna가 반환한 Markdown 판정·리다이렉션 명령·REQ BLOCKED 보고 호환성.
- `28775e2`: 환경 차단 이유 표시와 같은 테스트 방문의 GUI 수동 재개 검사.

| 검사 | 현재 확인 결과 |
|---|---|
| macOS arm64 / Node 25.2.1 코어·서버·CLI | 112 통과, Windows 전용 1 제외, 0 실패 |
| 개발 도구 / macOS 실행기 | 8/8, 4/4 |
| Chromium GUI | 16/16 (기존 15 + 환경 차단/재개) |
| 패키지 내용 / 설치 실행 / 운영 의존성 audit | 42개 파일 정상, 설치 실행 통과, 취약점 0 |
| 이번 변경의 Windows/Linux/Node 24 CI | 미실행, 새 Actions 링크 없음 |

플랫폼 suite는 508c7cb, GUI suite는 28775e2에서 실행했다. 두 커밋 간 제품 코드 차이는 없다. 초기 패키지 검사 실패와 최종 순차 재검증 성공을 모두 보존했다. [플랫폼 요약](../artifacts/verification/platform-darwin-arm64/summary.json), [GUI 요약](../artifacts/verification/browser-darwin-arm64/summary.json).

실제 모델 호출은 fake CLI 회귀 검사와 구분한다. 이전 게임/세션을 보존하고 바탕화면 `agent graph test/retest-20261023-175531`의 복사본에서 재검증했다.

| 실제 실행 | 결과 |
|---|---|
| GPT-6 Luna 기본 그래프 | 모델이 수정했으나 샌드박스 `listen EPERM`으로 테스트 BLOCKED / WAITING_USER. 구현을 반복하거나 성공으로 올리지 않았다. 운영자 환경의 게임 테스트는 15/15. |
| Kilo Auto Free 자율 수정 | 공급자 오류/무응답 이후 재개해 일부 수정했지만 복구 예산으로 PAUSED. 자율 완주 실패를 보존. |
| Kilo Auto Free 보완 후 검증 전용 그래프 | 운영자가 잔여 포인터/심볼릭 링크/테스트 API 오류를 보완한 뒤 같은 요청 모델로 npm test exit 0, 31/31을 관측하고 SUCCESS. 전체 자율 구현 성공과 구분. |

두 게임 모두 운영자 독립 엔진 검사 13개 묶음/4,000 비교, 저장값 경계 10개, HTTP 9개, CUA 브라우저 17개를 통과했다. 물리 터치스크린은 미검증이다. Kilo 수정 전 파일과 운영자 diff, 독립 테스트 원본, 실제 요청/라우팅 모델, 세션·attempt·로그·제품 해시를 로컬 결과 폴더에 보존했다. 네이티브 Codex가 실제 모델 ID를 보고하지 않아 요청 모델 gpt-6-luna만 확인했다. Kilo는 요청 `kilo/kilo-auto/free`를 유지했고 reflection/beam, nvidia/nemotron-3.5-super-vl:free, dots-studio/dots-3-note-preview:free 라우팅이 관측됐다.

실행 기록은 검사 실행 여부를 보강하며 테스트의 충분성을 보장하지 않는다. 모델의 코드/검사 품질, 네이티브 환경 제약, 공급자 가용성에는 여전히 감독이 필요하다. 이전 세션은 새 증거 필드 없이 읽되, 존재하지 않는 검증 기록을 통과 근거로 추정하지 않는다.

상세 로컬 결과: `/Users/supercent/Desktop/agent graph test/retest-20261023-175531/TEST_RESULTS.md`. 이번 실행의 새 CI 링크는 없으며 아래는 과거 커밋의 검증 이력이다.

## 이전 검증 이력

기준 코드: 1fc80c8. 검증일: 2026-10-13. 인수 기준은 [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)를 따른다.

상태: 기능 검증 완료. 계획의 24개 인수 기준을 구현·검사·수정 기록과 대조했다. 검증용 CLI를 사용하는 테스트와 실제 CLI의 모델 목록 조회를 구분했다.

## 최종 검증 결과

| 검사 | 결과 | 증거 |
|---|---|---|
| 빌드 및 타입 검사 | 통과 | backend와 frontend 타입 검사를 빌드에 포함; [빌드 로그](../artifacts/verification/build.log) |
| Node 24 단위·통합·공개 CLI | 69/69 통과 | [실행 로그](../artifacts/verification/node24-tests.log) |
| Node 24 + Chromium GUI | 9/9 통과 | [GUI 로그](../artifacts/verification/gui.log), [시나리오](../test/e2e/studio.spec.ts) |
| 데스크톱·태블릿·모바일 | 1440/800/390px 확인 | 전체 노드 화면 맞춤, 문서 및 패널 가로 넘침 검사; CUA 직접 확인 |
| npm 패키지 내용 | 통과 | 테스트·VSIX·개발 소스·실행 데이터 제외; [목록 검사](../artifacts/verification/package-contents.log) |
| 설치된 npm 패키지 | 통과 | CLI, 실제 JS/CSS 응답, 새 저장소, 네 모델 API, SDK 내장 CLI 없이 조회, IPC 정상 종료; [로그](../artifacts/verification/installed-package.log) |
| CLI 도움말 | 통과 | [로그](../artifacts/verification/cli.log) |
| 운영 의존성 audit | 알려진 취약점 0건 | [보고서](../artifacts/verification/audit.json) |
| 변경 파일 공백 검사 | 통과 | git diff --check |

실행 검증은 macOS arm64와 Node 24.21.0에서 수행했다. 호스트의 Node 25.2.1에서도 빌드·타입 검사와 앞선 회귀 시나리오를 확인했다. Windows·Linux·macOS의 Node 24 CI와 Linux 브라우저 CI를 구성했으며, 이 작업에서 원격 CI나 Windows/Linux 실기 실행 결과를 생성한 것은 아니다.

## 목표별 대조

모든 행의 결과는 통과다. 실제 제품 동작을 검사하는 시나리오와 소스 검토를 함께 사용했다.

| 인수 기준 | 구현 결과와 검증 증거 |
|---|---|
| APP-01 | Fastify 서버/세션 워커와 React/Vite/React Flow UI; Node 24 검사 및 설치된 패키지의 웹 응답 |
| APP-02 | 127.0.0.1 바인딩, 세션 쿠키, Host/Origin 검증; 인증 쿠키 누락·외부 Host·외부 Origin 거부 API 테스트 |
| APP-03 | ui/init/graphs/models/run/resume; 공개 CLI 테스트와 root/port/no-open을 사용한 설치 패키지 실행 |
| GRAPH-01 | 생성·복제·이름/설명 수정·삭제·JSON 내보내기/가져오기; 새 ID 확인 및 실행 snapshot 보존 GUI 검사 |
| GRAPH-02 | 노드 추가/드래그/삭제, 핸들 연결과 다음 단계 선택, undo/redo, 화면 맞춤과 줌 복원 GUI 검사 |
| GRAPH-03 | 6종 실행 유형, 역할명/지침, 공통 설정과 노드별 모델/추론 옵션; 바인딩 API 및 GUI 검사 |
| GRAPH-04 | 500ms 자동 저장, CAS/파일 잠금/원자 쓰기, 로컬 초안 보존; 두 창 충돌·재열기·새 그래프 저장 검사 |
| GRAPH-05 | 초안/실행 검증 분리; 부분 바인딩, 닫힌 순환, 중복 출력, 종료/재진입 구조 검사 |
| RUN-01 | 세션별 fork 워커, node/visit/attempt 분리; 정상 5단계 실행과 순환 재방문 검사 |
| RUN-02 | 방문별 계획 파일 및 session/node/visit/revision/request ID 승인; 재방문 새 승인·이전 승인 거부·중복 요청 검사 |
| RUN-03 | 그래프·연결·모델·실행 설정 snapshot; 라이브러리 변경 후 실행 snapshot 불변 검사 |
| RUN-04 | 앱 내 Markdown 미리보기·문서 수정·revision 저장·계획 선택/승인; GUI 완주 검사 |
| RUN-05 | Stop/Interrupt/Resume, lease, orphan 차단, watchdog, 재연결·완료 복구·자동 복구·반복 예산 검사 |
| RUN-06 | 브라우저 닫기/다시 열기, 정상 서버 종료, 예약 복구 취소, 계획 대기 복원, 워커 강제 종료 후 수동 재개 검사 |
| MODEL-01 | 수동 연결 등록만 제공; Codex/Claude/OpenCode/Kilo 모델 API 프로토콜 테스트와 실제 목록 조회 |
| MODEL-02 | 조회된 모델과 추론 옵션만 선택; 미등록 모델 사전 차단, 대체 목록/자동 모델 변경 없음 |
| MODEL-03 | 조회/실행에 동일 CLI와 대상 경로 사용; connection/binary/canonical target별 캐시 및 native cwd 검사 |
| MODEL-04 | 조회에 작업 프롬프트를 보내지 않음; timeout/취소 후 프로세스 사망 확인, SDK 제어 프로토콜 검사 |
| MODEL-05 | 실행/재개 전 목록 재조회; 모델 불일치와 인증 실패 WAITING_USER, 인증 복구 후 동일 방문 재개 검사 |
| TOOL-01 | MCP/웹/스킬/훅/플러그인은 CLI 설정 계승; pure/search/mcp 설정 주입 부재와 역할별 권한 인자 검사 |
| TOOL-02 | 검색 설정 사전 검사 제거; 완료된 검색과 assistant URL/사실 근거 또는 RESEARCH_BLOCKED로 판정 |
| TOOL-03 | 증거 요약을 출력 링과 별도로 누적; 파일 변경·검색·모델 사용 증거가 이벤트 폭주 후에도 유지됨 |
| UI-01 | 정상/좁은 화면 및 계획/완료 화면 확인; 모바일 메뉴·노드 선택·입력·저장·연결·버튼 동작 GUI 검사 |
| RELEASE-01 | 확장/VSIX/기존 설정 경로 제거, 새 저장 영역, README/CI/npm 갱신; 패키지 제외 목록 및 설치 실행 검사 |

## 발견한 문제와 수정·재검증

| 번호 | 발견한 문제 | 수정 | 재검증 |
|---|---|---|---|
| 1 | 계획 승인과 완료 상태가 세션 전체에 공유됨 | 방문별 계획 파일과 승인 키로 분리 | 계획 재방문, 이전 승인 거부, 중복 승인 테스트 통과 |
| 2 | 로그 이벤트 제거 시 판정 증거가 소실됨 | 독립 증거 요약을 전체 attempt 동안 누적 | 이벤트 폭주 후 mutation/search/spend 보존 통과 |
| 3 | 도구 관리 축소 후 웹 검색 설정 사전 검사가 실행을 차단함 | 실제 완료된 검색과 응답 근거로 판정 | 조사 완료/차단 및 Claude 성공 tool_result 검사 통과 |
| 4 | Claude SDK가 JS CLI 진입점을 native 바이너리로 실행함 | 실제 Node 실행 파일/prefix로 SDK spawn, Windows 래퍼 해석 | fake/실제 CLI 조회, SDK 내장 CLI 없는 설치 환경 통과 |
| 5 | 크기 변경·그래프 전환 후 노드가 잘리거나 작게 보임 | 노드 측정 후 맞춤, 그래프별 Canvas 초기화, 적용 성공 후 복원 완료 기록 | 3개 화면 크기 및 줌 저장/복원·반복 검사 통과 |
| 6 | 모바일에서 라이브러리와 노드 선택이 숨겨짐 | 모바일 그래프 선택/생성/가져오기와 노드 선택 메뉴 | 모바일 선택·역할 지침 입력·저장 통과 |
| 7 | 모바일 실행 영역의 큰 공백, minimap 겹침 | composer flex-basis와 캔버스 높이 조정, 모바일 minimap 숨김 | 스크린샷 및 가로 넘침 검사 통과 |
| 8 | 재열기 후 프로젝트 경로가 초기화됨 | 작업 공간별 대상 경로 저장/복원 | reload 후 경로 동일 검사 통과 |
| 9 | 컴파일된 테스트가 npm에 포함됨 | dist 자체 제외 규칙 생성 | 패키지 내용/설치 검사 통과 |
| 10 | 빠른 그래프 전환 중 입력·노드 선택이 유실됨 | 즉시 busy 적용, 제어 비활성화, 이전 Canvas의 지연 변경 차단 | 생성 직후 이름 입력 및 모바일 노드 선택 반복 검사 통과 |
| 11 | 프로그램 화면 맞춤이 자동 저장을 계속 미룸 | 사용자 gesture의 viewport 변경만 저장 | 노드 이동·줌·저장 검사 통과 |
| 12 | 서버 종료가 승인 대기 계획을 중지 상태로 바꿈 | 활성/예약 실행만 중지하고 대기 문서 보존 | 서버 재시작 후 문서·방문·승인 복원 통과 |
| 13 | crash 시 모델 사용 관측이 늦게 저장되고 마지막 attempt만 비용 판단에 사용됨 | 활동/사용량 변경을 즉시 저장, cycle 전체 사용량으로 판단 | 사용 관측 후 자동 재시작 방지와 crash 수동 재개 통과 |
| 14 | lease 해제 후 orphan PID 정보가 사라져 새 실행 가능 | attempt에 PID와 orphan 상태 보존, 재개/삭제 차단 | 살아 있는 orphan·외부 owner 차단 통과 |
| 15 | 모델 조회 중 Interrupt가 잘못 WAITING_USER로 전환됨 | 취소된 연결을 새 signal로 다시 검증 후 중단 노드 실행 | 조회 중 Stop/Interrupt 및 child 종료 확인 통과 |
| 16 | lease 없는 RUNNING 상태가 계속 남음 | 시작 유예 후 PAUSED로 전환하고 수동 판단 요청 | 자동 비용 사용 없이 상태 복구 통과 |
| 17 | 프런트 타입 오류가 일반 빌드에서 누락됨 | 웹 타입 검사도 build에 포함 | backend/frontend 타입 검사와 GUI 렌더링 통과 |
| 18 | Windows 패키지 검사에서 SIGTERM을 정상 종료로 오인함 | managed launcher의 IPC 종료를 같은 close 경로로 처리 | 설치 패키지 정상 종료 통과; Windows는 CI 실행 대상 |
| 19 | OpenCode 전체 접근에 지원되지 않는 CLI 옵션 사용 | 실제 도움말의 --auto 사용, 읽기 역할에는 적용하지 않음 | native 도움말 대조 및 권한 인자 테스트 통과 |
| 20 | OpenCode/Kilo API의 variant map이 누락됨 | 보고된 variant key만 정규화하고 disabled/옵션 값 제외 | 변형 목록/비밀값 제외 테스트 및 실제 API 옵션 조회 통과 |
| 21 | 워커 강제 종료 직후 젊은 state lock이 30초 동안 재개를 막음 | 종료가 확인된 owner의 잠금 즉시 회수, 회수 요청 직렬화 | 새 abandoned lock 동시 회수와 crash 재개 통과 |
| 22 | heartbeat가 child PID를 놓치면 이전 CLI가 남을 수 있음 | lease와 저장된 attempt PID를 함께 정리하고 crash attempt 기록 | lease childPid를 지운 crash 재개 검사 통과 |
| 23 | 모바일 CSS 다단 배치가 설정을 가로로 밀어 숨김 | 태블릿 2열/모바일 1열 grid 및 세로 스크롤 | 내부 scrollWidth 검사와 실제 설정/지침 입력 통과 |
| 24 | 저장 응답은 성공했는데 대기 표시가 남음 | 표시를 실제 draft dirty와 저장 실패/충돌 상태에 맞춤 | 저장 완료 후 이름/설정 읽기, 삭제, 줌 복원 검사 통과 |

검증 코드도 반복 실행에서 같은 그래프 이름을 누적하는 대신 UUID로 식별하도록 정리했다. API 오류 코드의 예상값을 실제 계약에 맞추고, 비활성화된 모바일 선택기를 조작하지 않도록 제어 상태를 명시했다.

## 실제 CLI 조회 및 검증 범위

코딩/추론 요청 없이 임시 대상 폴더에서 native 모델 API만 호출했고 조회 프로세스를 정리했다.

| CLI | 조회 상태 | 모델 수 | 보고된 추론 옵션 수 |
|---|---|---:|---:|
| Codex | ready | 3 | 17 |
| Claude Code | ready | 4 | 15 |
| OpenCode | ready | 116 | 358 |
| Kilo | ready | 441 | 1,155 |

[실제 조회 요약](../artifacts/verification/native-models.json). 목록 조회 성공은 모든 모델의 실제 할당량·추론 권한을 보증하지 않는다. 코딩 실행·복구 시나리오는 결정적 fake CLI로 검증했으며 실제 모델에 유료 코딩 작업을 보내지 않았다.

플랫폼 종료 차이의 근거는 [Node.js child process 문서](https://nodejs.org/api/child_process.html#subprocesskillsignal), 추론 variant map의 형식은 [OpenCode 모델 문서](https://opencode.ai/docs/models/#custom-variants)를 대조했다.

## 화면 증거와 재현

- [데스크톱 편집기](../artifacts/screenshots/editor-desktop.png)
- [800px 레이아웃](../artifacts/screenshots/layout-narrow.png)
- [390px 레이아웃](../artifacts/screenshots/layout-mobile.png)
- [모바일 노드 편집](../artifacts/screenshots/mobile-controls-verified.png)
- [계획 수정·승인](../artifacts/screenshots/plan-review.png)
- [실행 완료](../artifacts/screenshots/run-complete.png)

~~~sh
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
npm run smoke
npm run pack:check
npm run pack:smoke
npm audit --omit=dev --audit-level=high
~~~

검증 로그·스크린샷·가짜 실행 데이터는 artifacts 아래에 보존하되 Git/npm 배포에서 제외한다. 저장소의 원래 사용자 세션은 변경하거나 변환하지 않았다.

## macOS 파일 실행기 추가 검증 — 2026-10-14

프로젝트 폴더에 `Agent Graph Studio.app` 실행기를 추가했다. AppKit 창에서 준비 상태를 표시하고 기본 브라우저를 열며, 실행 로그와 종료 버튼을 제공한다. Node.js 24 이상은 별도 설치가 필요하고 실행기는 소스 프로젝트 폴더와 함께 사용한다.

- macOS 네이티브 실행 파일 빌드 및 로컬 서명 성공.
- 실행기 통합 테스트 2/2 통과: 서버 생성·정적 자산 제공·같은 서버 재사용·소유한 서버만 종료, 다른 서비스가 사용하는 포트 거부.
- 실제 앱 실행으로 브라우저의 그래프 편집기 표시 확인. 종료 버튼과 Cmd+Q 각각 실행기·도우미·서버 프로세스 종료 확인.
- 실제 실행 환경은 macOS / Node.js 25.2.1이며, 추가 테스트는 임시 작업 공간을 사용하고 코딩 CLI를 호출하지 않았다. 이전 코어·GUI 전체 검증 횟수와 별도로 기록한다.

[빌드 로그](../artifacts/verification/macos-launcher-build.log), [테스트 로그](../artifacts/verification/macos-launcher-tests.log), [실행 창](../artifacts/screenshots/macos-launcher.png).

~~~sh
npm run build:launcher:mac
npm run test:launcher:mac
~~~

## QA 오류 판정 수정 인수 기준 — 2026-10-14

실제 Kilo QA 로그에서 ID·시간의 `401/403`이 인증 실패로 오인되고, 실행되지 않은 `ls … 2>/dev/null` 호출이 파일 변경으로 오인되는 문제를 재현했다. 수정은 CLI 진단과 일반 출력 분리, 명시적 실패 종류 우선 보존, 호출별 실행 상태 추적, 명령 입력의 따옴표·리다이렉션 구분을 대상으로 한다. 기존 사용자 데이터·승인 기록은 보존하며 임시 작업 공간과 가짜 CLI로 검증한다.

### 구현과 검증 결과

- `SupervisorResult.diagnostics`와 `Completion.failureKind`를 내부 계약에 추가했다. 오류 메시지는 비밀값을 제거하고 각각 최대 2 KiB로 제한하며 최근 이벤트 보존 한도와 별도로 유지한다. 최종 공급자 실패는 종료 코드 0과 완료 표시가 있어도 실행 실패로 처리한다.
- 중지·타임아웃·프로세스 종료 미확인·명시적 권한 오류는 보존한다. 인증은 실제 오류 코드·HTTP 상태·명시적인 실패 진단으로 판정하고, 403만으로는 로그인 필요를 단정하지 않는다. 모델 조회도 같은 판정기를 사용한다.
- 파일 변경은 알려진 CLI 이벤트와 명령 입력에서만 검사한다. 호출 ID로 요청과 결과를 연결해 실행 전 거부를 제외하고, 부분 실패·결과 미확인·완료된 변경은 보수적으로 유지한다. `/dev/null`, 스트림 연결, 따옴표·이스케이프를 구분하며 실제 쓰기가 섞인 명령과 명령 래퍼도 검사한다. QA의 native 읽기 전용 설정은 유지했다.
- macOS / Node.js **24.21.0**에서 코어·통합·CLI 테스트 **93/93** 통과(기존 69개와 추가 24개), GUI **11/11** 통과(기존 9개와 추가 2개). 타입 검사, npm 패키지 내용 검사 및 실제 임시 설치 검증도 통과했다.
- GUI에서 실제 인증 실패의 노드·연결·원인 표시, 중지·브라우저 재로드·수동 재개를 검사했다. 같은 QA 방문의 두 번째 시도로 완료되고 계획·구현·테스트 방문, 승인 참조, 이전 오류 기록이 보존됐다. 오탐 재현 이벤트는 QA를 한 번만 실행한 뒤 최종 승인으로 진행했다.
- 원래 QA 로그 두 개를 읽기 전용으로 재판정했다. 첫 로그는 파일 변경·인증 오탐이 사라졌고, 두 번째 로그는 완료 표시 누락으로 구분됐다. 로그에는 원래 종료 코드가 저장되지 않아 이 재판정은 정상 CLI 종료를 가정하며, 실제 종료 및 복구 경로는 별도의 가짜 CLI 통합 테스트로 검증했다.
- 사용자 작업 공간의 기존 18개 파일은 수정 전후 SHA-256이 동일했다. 기존 시도를 다시 판정해 저장하거나 이전 응답을 자동 승인하지 않았고 실제 모델에 코딩 요청을 보내지 않았다. 저장 데이터는 기존 stateVersion 3을 유지한다.
- macOS 더블클릭 실행기 통합 테스트도 **2/2** 통과했다. 수정된 소스로 빌드·서버 실행·기존 서버 재사용·소유한 서버만 종료하는 동작을 확인했다.

[코어·CLI 로그](../artifacts/verification/qa-core-tests.log), [GUI 로그](../artifacts/verification/qa-gui-tests.log), [설치 패키지 검증](../artifacts/verification/qa-installed-package.log), [실제 로그 재판정](../artifacts/verification/qa-real-log-replay.json), [인증 오류 표시](../artifacts/screenshots/qa-auth-error-context.png), [QA 재개 완료](../artifacts/screenshots/qa-resume-verified.png).

## Windows Node 24 환경 복원 및 실행 수명 수정 — 2026-10-23

Windows x64의 기본 Node.js를 22.20.0에서 **24.22.1 LTS**로 갱신했다. npm은 **11.14.1**이며, `npm ci`로 기존 lockfile의 311개 패키지를 복원했다. 직접 의존성 17개가 선언과 일치하고, 복원 시 audit 결과는 알려진 취약점 0건이었다. 의존성 누락 및 Node 타입 인식 오류는 복원 후 해소되어 TypeScript 설정 변경은 필요하지 않았다.

### 발견한 문제와 수정

- 모델 조회가 PID 종료만 확인하고 반환해 Windows에서 임시 작업 폴더 삭제가 `EBUSY`로 실패했다. 프로세스와 표준 입출력의 `close`까지 제한 시간 안에 기다리도록 수정하고 회귀 테스트를 추가했다.
- ConPTY는 프로세스 종료 후 출력 배출을 마친 다음 종료 이벤트를 보낸다. 이 사이 watchdog이 정상 완료를 timeout으로 오인했다. 프로세스가 이미 종료된 경우 최종 종료 이벤트를 제한된 시간 동안 기다리고, 실제 종료 코드 및 공급자 오류 진단으로 판정하도록 수정했다. Windows ConPTY에서 정상 완료와 종료 코드 0의 인증 실패를 함께 검사한다.
- ConPTY의 네이티브 핸들 때문에 완료·승인 대기 워커가 계속 살아 있어 다음 실행이 거부됐다. 런타임의 상태·로그 저장과 lease 해제가 끝나고 IPC 전송이 배출되면 단일 세션 워커를 종료하도록 수정했다.
- 인증 대기로 전환한 직후 Stop을 누르면 종료 중인 워커에 중지 요청이 남아, 수동 재개한 새 워커가 다시 STOPPED로 전환됐다. 대기 상태 워커의 종료를 확인한 뒤 중지·중단 요청을 처리하며, 종료 확인 한도를 넘기면 재시도를 요청하고 새 제어 요청을 남기지 않는다. 기존 QA 인증·Stop·동일 방문 재개 시나리오로 검증했다.
- Windows의 PTY 출력 지연을 고려해 테스트의 세션 대기 한도와 진행 갱신 검사의 시간 여유를 조정했다. 갱신 검사에서 단계 제한은 여전히 1,200ms 작업보다 짧아 실제 진행 갱신을 요구한다. 실제 실행의 timeout 기본값은 변경하지 않았다.

### 최종 검증 결과

| 검사 | 결과 | 증거 |
|---|---|---|
| Node 24에서 의존성 복원 | 통과, audit 0건 | npm ci (현재 확인 불가: 당시 로컬 자료 `../artifacts/verification/windows-node24-install.log`) |
| 백엔드·프런트엔드 타입 검사 | 통과 | 타입 검사 (현재 확인 불가: 당시 로컬 자료 `../artifacts/verification/windows-node24-typecheck.log`) |
| 코어·웹 빌드 및 코어·통합·공개 CLI | **95/95 통과** | 빌드·테스트 (현재 확인 불가: 당시 로컬 자료 `../artifacts/verification/windows-node24-tests.log`) |
| Chromium GUI | **11/11 통과** | GUI 검사 (현재 확인 불가: 당시 로컬 자료 `../artifacts/verification/windows-node24-e2e.log`) |
| 공개 CLI 도움말 | 통과 | smoke (현재 확인 불가: 당시 로컬 자료 `../artifacts/verification/windows-node24-smoke.log`) |
| npm 패키지 내용 | 통과, 31개 파일 | 패키지 목록 검사 (현재 확인 불가: 당시 로컬 자료 `../artifacts/verification/windows-node24-pack-check.log`) |
| 임시 설치한 npm 패키지 | CLI·웹 자산·새 저장소·4종 모델 API·정상 종료 통과 | 설치 검사 (현재 확인 불가: 당시 로컬 자료 `../artifacts/verification/windows-node24-pack-smoke.log`) |

실행과 모델 조회는 결정적 가짜 CLI를 사용했다. 이번 검증은 Windows 환경에서 수행했으며 macOS 네이티브 실행기 빌드는 포함하지 않는다. 빌드는 성공했고, 약 611kB의 웹 JavaScript 번들에 대한 크기 경고가 남는다. 로그는 기존 정책대로 Git/npm 배포에서 제외하는 `artifacts/verification`에 보존한다.

## 실제 Kilo Auto Free로 웹 2048 생성 및 검증 (2026-10-23)

위의 결정적 가짜 CLI 검사와 별도로, 로컬 Studio에서 실제 Kilo 네이티브 CLI 7.8.15에 연결해 445개 모델을 조회하고 `kilo/kilo-auto/free`를 지정했다. 승인한 계획으로 `experiments/kilo-2048-web-20261023`에 웹 2048을 생성했다. 독립 테스트에서 발견한 무효 이동의 타일 생성, 저장 데이터 검증, 첫 방문의 새 게임 버튼, 승리 후 게임 오버 표시 오류는 Kilo가 수정했다.

생성한 게임의 테스트 13/13, 별도 규칙 검사 10/10 및 독립 기준 구현과의 이동 비교 4,000건이 통과했다. 실제 브라우저에서 방향키, 새 게임, 저장 복원, 390px 렌더링을 확인했다. 터치는 이벤트 단위 테스트로 검사했으며 물리 장치에서의 스와이프 검증은 포함하지 않는다.

게임 검증은 통과했지만 **전체 자동 실행 그래프는 PAUSED**다. 구현 방문은 성공했고, 테스트 단계에서 Auto Free의 연속 잘못된 write 인자로 정지했으며 피드백을 담은 중단 분석도 초기 PTY 출력 120초 timeout으로 정지했다. QA 검토·최종 승인 노드는 실행되지 않았다. 실제 세션 ID는 `1fbcfb7e-0526-45f2-a45b-034d5c85fef1`이다.

상세 재현 방법, 모델·상태 기록, 실패 이력, 자동 검사 결과, 데스크톱·모바일 화면은 실제 실행 보고서 (현재 확인 불가: 당시 로컬 자료 `../artifacts/verification/kilo-2048/VERIFICATION.md`)에 보존했다. 현재 실행 요약은 Kilo의 중첩 모델·토큰 필드를 반영하지 못하므로 실제 라우팅은 원시 CLI 로그를 기준으로 별도 확인했다.

## 실제 Auto Free 전체 루프 복구 및 최종 승인 (2026-10-23)

후속 진단에서 모델의 빈 write 인자, 무료 제공자의 용량 부족, Windows ConPTY의 긴 JSON 전송 손상, PowerShell의 npm.ps1 실행 정책, 요구사항 증거 형식 누락이 서로 다른 원인으로 확인됐다. Windows Kilo에는 stdout/stderr를 별도로 처리하는 파이프 전송을 적용했고, 실제 모델·토큰 기록과 원인별 제한된 재시도, 모든 REQ별 보고서 형식 보완을 추가했다. 실제 실패 증거에 대한 FAIL/REJECTED와 요구사항 완료 기준은 유지했다.

최신 실제 세션 `198e9de6-d065-415d-89cb-33d65e20a12c`은 **SUCCESS**다. 기승인 계획을 사용한 구현 → 테스트 PASS → QA APPROVED → 최종 APPROVED가 각각 첫 시도에 완료됐다. 모든 요청은 `kilo/kilo-auto/free`이며 테스트·QA·승인 각각에 원래 요구사항 8개의 SATISFIED 증거가 있다. 정상 네이티브 최종 응답과 Studio 기록의 정확한 일치도 확인했다.

타입 검사·빌드, 코어/서버/CLI **105/105**, GUI **11/11**, 패키지 **32개 파일** 검사가 통과했다. 게임 테스트는 Auto Free가 추가한 타일 4 생성·게임 오버 재시작 검사를 포함해 **15/15**, 별도 규칙 검사 **10/10** 및 네 방향 독립 비교 **4,000건**이 통과했다. 호스트 실행 정책을 변경하거나 저장된 성공 상태를 직접 조작하지 않았다.

복구 및 전체 루프 검증 보고서 (현재 확인 불가: 당시 로컬 자료 `../artifacts/verification/kilo-2048-recovery/VERIFICATION.md`)에 원인·회귀 검사·이전 중지 시도·최종 실제 상태·승인 화면을 보존했다. 앞 절의 PAUSED 및 모델/토큰 누락은 최초 검증 당시 상태이며 이번 후속 수정으로 보완했다.

## 검증 자료 보존 정책

`npm run verify:platform`과 `npm run verify:browser`는 검사별 stdout/stderr와 `summary.json`을 `artifacts/verification/<suite>-<platform>-<arch>/`에 기록한다. 요약은 커밋 SHA, 작업 트리 변경 여부, 실행 환경, 명령, 시작/종료 시각, 종료코드, 성공·실패·미실행 상태를 포함한다. 앞 검사가 실패하면 뒤 검사는 미실행으로 남고 최초 실패 종료코드를 반환한다.

CI는 성공·실패와 관계없이 OS·커밋·실행 ID·회차별 artifact를 90일 보존한다. 브라우저 artifact에는 스크린샷과 실패 trace도 포함한다. Git에는 결과 요약과 해당 Actions 실행 링크를 기록하며, 만료 후에도 요약은 남지만 원본 artifact는 다시 내려받을 수 없을 수 있다. 기존 `../artifacts/` 링크는 당시 로컬 기록으로 공유 저장소의 영구 증거가 아니다.

실제 CLI를 사용한 과거 기록은 실행 당시 문서이며, fake CLI 자동 검증과 구분한다. 사용자 홈의 실행 세션·인증 설정·실제 모델 로그는 수집하지 않는다.

## 실행 환경·레거시·검증 보존·프런트엔드 정리 — 2026-10-23

검증 대상 구현 커밋: `ccc44861e7f6b51d88f96315f6b7e73b158030cd`. [GitHub Actions 실행](https://github.com/youwonsock/custom-agent-loop-system/actions/runs/39915902762). 로컬 검증 커밋 `b58f46b88b475840d7242061ea1bb8c398ce1eca`와 Git tree `336d4acc821836825e960a0cad99c114f24c7652`가 동일하다. 로컬과 CI에서 같은 구현을 검사했다.

### 변경 내용

- 현재 lockfile로 로컬 설치를 복원했다. macOS 실행기는 manifest/lockfile 해시, Node major·ABI, OS·아키텍처, 직접 의존성 버전과 node-pty 로딩을 확인한다. 초기화는 프로젝트 잠금으로 직렬화하고, 설치 실패·취소 시 성공 정보를 남기지 않는다. 기존 서버 재사용과 소유한 서버만 종료하는 동작을 유지했다.
- 이전 desktop-app·native 빌드 산출물과 미사용 Tetris 데모 29개 추적 파일, 로컬 VS Code 확장 잔재를 제거했다. 현재 macOS 실행기·가짜 CLI fixture·Kilo 2048 예제는 유지했다.
- 플랫폼/브라우저 검증 명령, 실패 시에도 남는 결과 요약과 로그, OS·커밋·회차별 90일 CI artifact를 추가했다. 명시적인 실패와 실행 파일 누락이 성공으로 보고되지 않는 회귀 검사를 포함한다.
- App.tsx를 2,138줄에서 220줄로 줄이고 화면과 상태 hook을 분리했다. 화면 전환 동안 상태 소유자를 유지하며, 화면·Markdown을 지연 로딩하고 비활성 로그 요청을 취소한다. 지연 로딩 오류는 화면에 표시하고 새로고침으로 복구한다.

### 검증 결과

| 검사 | 로컬 macOS arm64 / Node 25.2.1 | Node 24 CI |
|---|---|---|
| 타입 검사·빌드 | 통과 | Windows·Linux·macOS 통과 |
| 코어·서버·CLI | 104 통과, Windows 전용 1 제외, 실패 0 | Windows 105 통과/제외 0; Linux·macOS 각각 104 통과/Windows 전용 1 제외 |
| 실행 환경·검증 기록 도구 | 8/8 통과 | Windows·Linux·macOS 각각 8/8 통과 |
| macOS 실행기 빌드·통합 | 4/4 통과 | macOS 4/4 통과 |
| Chromium GUI | 15/15 통과 | Linux 15/15 통과 |
| 패키지 내용·설치 smoke | 40개 파일, 모든 지연 로딩 자산 응답까지 통과 | Windows·Linux·macOS 통과 |
| 운영 의존성 audit | 취약점 0건 | Windows·Linux·macOS 각각 취약점 0건 |

Actions 실행은 네 작업 모두 성공했고, OS별 플랫폼 artifact 3개와 브라우저 artifact 1개의 업로드를 확인했다. 각 artifact 이름에 OS·구현 SHA·실행 ID·회차가 포함되며, 만료 예정일은 2027-01-21이다.

브라우저 검사는 기존 11개 시나리오에 화면 전환 중 저장·연결 입력 보존, SSE 단일 구독 및 로그 polling 취소, 지연 로딩 실패 복구, 초기 JS 요청 용량 검사를 추가했다. 기존 계획 승인 시나리오에서도 화면 전환 후 편집 중인 문서 보존을 확인한다. 로컬에서 기본 그래프 화면의 실제 JS 응답 합계는 압축 전 **442,952 bytes**로, 이전 단일 번들 610.60 kB보다 약 27% 줄었다. 개별 청크도 500,000 bytes 이내이며 경고 한도는 올리지 않았다.

실제 모델 작업이나 새 인증 요청은 수행하지 않았다. REST/SSE 계약, 공개 CLI 옵션, 그래프·연결·세션 버전과 localStorage 키, 의존성 lockfile 및 코어 실행 엔진은 변경하지 않았다. 네이티브 macOS 창의 수동 조작은 이번 검증에 포함하지 않으며, Swift 빌드와 실제 Node 실행기/서버 통합을 검사했다.

## 자율 실행 복구와 Kilo Auto Free 실제 검증 — 2026-10-24

실제 검증 구현 커밋: `d2e6c8e8f71792cb2b7c02177d2abafbfd14f599`. macOS arm64 / Node 24.21.0에서 코어·서버·CLI 211 통과, Windows 전용 1 제외, GUI 25 통과, 패키지 내용 검사 통과를 확인했다. 이번 변경의 원격 CI는 실행하지 않았으므로 새 Actions 링크는 없다. 의존성 버전은 변경하지 않았다.

재시도 시작 이벤트를 실제 진행과 구분하고, 반복 공급자/도구 스키마 실패를 유한 재시도로 넘겼다. 보조 제목 모델 오류를 주 요청 진단에서 분리했고, 누락 검사와 보고서 형식 보완을 구분했다. 읽기 전용 역할에는 브라우저 실행/명세 작성 지시를 제거했다. 계획의 알려진 ID 목록·범위만 참조로 해석하며 테스트·QA·최종 승인 증거와 실제 실행 게이트는 완화하지 않았다.

실제 모델 `kilo/kilo-auto/free`로 게임 소스가 없는 새 폴더에서 계획 → 제작 → 테스트 PASS → QA APPROVED → 최종 APPROVED → SUCCESS를 확인했다. 세션 `fcaccfe0-9d14-47a8-9d6c-805c02e54d4f`, 약 38.4분, 네이티브 시도 11회(테스트 역할 7회 시도 포함), 수동 승인·재개·수정·중지 요청 0회다. 자체 Node 테스트 22개, 제공한 고정 인수 검사(엔진 13그룹/4,000비교, 컨트롤러 12그룹, 실제 Chromium 4그룹)와 플랫폼 Chromium 39단계가 통과했다. 고정 검사 파일과 명세는 시작 후 변경하지 않았고, 최신 브라우저 소스 해시와 현재 파일이 일치하며 successBlockers는 비어 있다.

최종 성공 전 별도 개발 시험의 중지 1회와 이전 버전의 자연 PAUSED 시험은 성공 실행과 구분해 보존했다. 큰 정수 검증·터치 중복 오류의 실제 실패 재현과 정상 산출물에서 인수 검사 4/4 통과도 별도로 남겼다. 이번 실행이 생성한 로그·상태·화면·trace만 사용자 지정 Desktop 폴더에 저장했고, 사용자 홈 인증/과거 세션은 복사하지 않았다. 소유 서버·워커와 확인한 포트 16개를 정리했고 SUCCESS 이력은 유지했다.

상세 로컬 결과: `/Users/supercent/Desktop/agent graph test/kilo-autonomy-verified-20261024-191418/TEST_RESULTS.md`, 기계 요약 `RESULTS.json`, `results/final-evidence.json`, `results/cleanup-verification.json`. 이는 이번 환경·목표의 성공 근거이며 공급자 상시 가용성, 실제 청구액, 모든 임의 목표의 무인 완주를 보장하는 기록은 아니다.

## 테스트 역할·근거·후속 예산 보존 — 2026-10-25

최신 실제 검증 코드: `ce9d64fdcb09ef44e9decb3d6684ae6fdd0ac3be`. macOS arm64 / Node 24.21.0의 깨끗한 작업 트리에서 코어·서버·CLI **273 통과, Windows 전용 ConPTY 1 제외, 실패 0**, 도구 10/10, Chromium GUI 25/25, macOS 실행기 4/4, 패키지 75개 파일·설치 smoke, 운영 의존성 audit 취약점 0을 확인했다. `verify:platform` 다음 `verify:browser`를 순차 실행했다. 새 Windows/Linux 원격 CI·push·main 병합은 수행하지 않았으므로 이번 코드의 Actions 링크는 없다.

새 자율 프리셋은 테스트의 native 쓰기/임의 실행과 첫 등록 검사 실패를 실행 전 차단 또는 즉시 FAIL로 구현에 반환한다. 숨은 소스 변경도 250ms polling 및 종료 후 해시로 확인한다. verification 출력 준비와 소스 변경을 구분하고, 원시 명령을 보존하면서 무효화 이유·파일·시각을 기록한다. Test PASS 입력 snapshot은 검토·최종 승인 전후와 성공 시점에 다시 확인한다. 전체 60분/24회와 고정 역할 마감·후속 호출 예약을 유지하고, 미완료 단계는 PAUSED로 보존한다. native 일괄 프로세스 종료 차단, 짧은 정책 이벤트의 마스킹 지연 수정, 안전한 출력 폴더 준비·절대 경로 정규화, 실제 검사 종료코드 보존도 포함한다. 선택 필드 없는 기존 그래프와 REST/SSE/공개 CLI·저장 버전은 유지하며 의존성 버전은 변경하지 않았다.

세 번째 새 프로젝트의 실제 모델 `kilo/kilo-auto/free` 실행은 제작 → Test PASS → 독립 검토 APPROVED → 최종 승인 APPROVED → **SUCCESS**로 끝났다. 세션 `8f7e2957-1906-4282-931a-f23a72c9b33d`, 2026-10-25 06:21:21~06:47:21 KST, 약 26분·native CLI 10회, 시작 후 운영자 대상/플랫폼 수정·피드백·수동 승인·재개·중지·예산 변경은 0회다. 보호 검사 6개만 제공했고 이전 게임·자체 테스트를 복사하지 않았다. Test 역할의 보고서 파일 쓰기와 상태 echo 조회는 실행 전에 차단돼 구현으로 자동 반환됐고, 세 번째 Test는 여섯 필수 검사를 모두 새로 실행해 통과했다. 검토도 canonical 품질 보고서 읽기를 한 번 자동 보완했다.

자체 Node 테스트는 엔진 8·컨트롤러 6·저장 6·HTTP 5로 총 25개 통과했다. 네 영역 no-op 제어와 선언된 실제 제품 결함 12개 탐지를 확인했다. 고정 엔진 13그룹/4,000비교·컨트롤러 12그룹·실제 Chromium 인수 4그룹과 플랫폼 브라우저 39단계도 통과했다. 두 독립 승인 역할은 각각 자체 테스트 네 파일과 품질 보고서를 native read로 읽었다. 보호 파일 6개, Test 입력 snapshot 19개, 실행 dist 183개의 무결성과 기능 증거 21개 항목이 일치했다. 테스트 역할의 실제 소스 변경은 0회다. 자연 SUCCESS 뒤 workflow stop 없이 관리 서버를 종료했고, 기록 PID 129개·포트 7개 및 해당 실행 폴더 cwd 프로세스가 모두 정리됐다.

**전체 관찰 결과는 PASS_WITH_FINDINGS다.** 플랫폼의 기능 무인 완주는 성공했지만 계획 역할이 대상의 부모 검증 폴더와 사용자 Kilo 설정 폴더를 glob 조회한 2건이 확인됐다. 성공한 외부 파일 내용 읽기는 확인되지 않았고 외부 실행 state.json 읽기는 실패했다. 인증/과거 세션 원본을 별도 수집하지 않았으나 target-only 탐색 제약을 완전히 충족했다고 판단하지 않는다. native 읽기/탐색 범위 보완은 남은 우선순위이며 현재 가드를 OS 샌드박스로 해석하지 않는다. 보고서를 파일로 쓰려는 모델 행동·조회 상태 표현·동일 보고서의 경로 차이에 따른 복구 비용도 남아 있다. 무료 상태는 native 메타데이터 기준이고 실제 청구액 및 공급자 내부 요청/토큰 예산은 측정하지 않았다.

첫 실제 시도 `571cea1c-074e-49f5-9eb3-199ba79dc2e7` / `d69903d`는 광범위 pkill 반복 때문에 운영자 안전 중단 1회로 STOPPED(약 30분/4호출)됐다. 두 번째 `e16de1b5-7224-45c0-a943-92e602691839` / `efe1225`는 준비·조회 오차단 및 지연 뒤 고정 구현 마감에 PAUSED(약 42분/13호출), 운영자 제어 0회다. 이 실패들을 성공으로 세거나 재시작 이력을 숨기지 않았다. 초기 요구사항 개수 불일치 API 요청은 세션/모델 생성 전 거절된 사전 점검으로 별도 보존했다.

상세 결과: `/Users/supercent/Desktop/agent graph test/kilo-normalized-verification-20261025-061825/TEST_RESULTS.md`, `RESULTS.json`, `FINDINGS.md`, `results/native-scope-audit.json`, `results/hardening-evidence.json`, `results/cleanup-verification.json`. `results/workflow-evaluation.json`의 21개 기능 PASS와 범위 감사의 미해결 사항을 분리해 보존한다. 1·2차의 상세 로그와 중단/정리 증거도 각각의 Desktop 실행 폴더에 남아 있다.

## Kilo 대상 밖 조회 차단 및 무인 재검증 — 2026-10-25

실제 검증 코드: `2fc62087cc48667f7fa8b5752ae0bc6c1a0b0c6b`(경계 가드 `3983c0850d43f7a0926f4ac4c446ffe513a48758` 및 조회 구문 보완 포함). macOS arm64 / Node 24.21.0의 깨끗한 커밋에서 코어·서버·CLI **284 통과, Windows ConPTY 전용 1 제외, 실패 0(총 285)**, 도구 10/10, Chromium GUI 25/25, macOS 실행기 4/4, 패키지 77개 파일·실제 설치 smoke, 운영 의존성 audit 0건을 확인했다. 플랫폼 검사와 브라우저 검사를 순차 실행했다. 이 회귀 검사의 결정적 fake CLI와 아래 실제 모델 실행은 구분한다. 새 Windows/Linux 원격 CI·push·main 병합은 수행하지 않았으며 이번 구현의 새 Actions 링크는 없다.

새 자율 프리셋의 `targetScopeGuard=true`는 Kilo의 계획·구현·테스트·검토·최종 승인 전체에 invocation-local hook과 native external_directory 기본 deny를 적용한다. 관찰 가능한 native 파일 도구 및 제한된 literal 조회에서 부모/홈/다른 프로젝트·외부 심볼릭 링크·모호한 경로를 실행 전에 거절한다. 재귀 조회는 실제 경계를 확인하며 10,000개 항목을 넘으면 더 좁은 경로를 요구한다. 따옴표 속 명령 구분자, 옵션 뒤 경로, 안전한 stderr 폐기와 조건부 작업 폴더를 검사하고, 대상 내부의 단순 절대 경로는 공백을 포함해 정규화한다. 조회 fallback/상태 echo는 검사 receipt를 만들지 않으며, 등록 검사의 실제 실패·종료코드·쓰기 금지는 유지한다.

`SCOPE_DENIED`는 실행 전 거절로 기록해 같은 모델 호출에서 대상 안 경로로 수정할 수 있다. 실제 외부 접근 또는 미확정 외부 호출은 BLOCKED로 보존한다. 모든 Kilo 시도의 `scopeAudit`을 bounded event ring 밖에 저장하고, 감사 누락·경계 불일치·외부 조회·미확정 기록이 있으면 SUCCESS를 차단한다. 기존 그래프의 선택 필드가 없으면 종전 정책을 유지한다. 의존성 버전, 공개 CLI 옵션, REST/SSE endpoint 및 그래프/연결/세션의 저장 버전은 바꾸지 않았다.

실제 `kilo/kilo-auto/free` 세션 `8da09a74-27db-49b3-a616-86387616c46e`는 **계획 → 제작 → Test PASS → 독립 검토 APPROVED → 최종 승인 APPROVED → SUCCESS**로 자연 종료했다. 2026-10-25 14:48:37~15:32:17 KST, 약 43.66분·native CLI 15회이며 시작 후 운영자의 소스/빌드/대상 수정·피드백·수동 승인·재개·재시작·중지·예산 변경은 0회다. 요구사항 12개와 기본 60분/24회, 고정 역할 마감을 유지했다. 고정 검사/명세 6개만 제공했고 이전 게임·자체 테스트를 복사하지 않았다. 게임과 자체 테스트는 모델이 작성·수정했다.

첫 Test는 잘못된 `won: "false"` 저장값을 허용하는 제품 결함으로 컨트롤러 검사가 종료코드 1을 반환해 구현으로 자동 반환됐다. 두 번째 Test의 등록되지 않은 inline Node 진단 실행도 정책에 의해 거절됐다. 구현은 자체 테스트가 놓치던 이동 무시·저장 예외 전파 결함, 저장소 getter 거부와 드래그 입력의 실제 브라우저 실패를 수정했다. 5분 무응답 2회와 Test 보고 표식 누락 1회, 최종 보고 schema/JSON 오류 3회도 자동 복구했다. 최종 승인은 네 번째 호출에서 유효한 보고가 수락됐으며, 실패·잘못된 보고를 성공으로 바꾸지 않았다.

최종 자체 Node 테스트는 엔진 8·컨트롤러 6·저장 6·HTTP 5로 **25/25**이고, 네 영역의 no-op 제어 및 실제 제품 결함 12개 탐지가 통과했다. 고정 엔진 13그룹/4,000비교·컨트롤러 12그룹·실제 Chromium 인수 4그룹·플랫폼 브라우저 39단계도 통과했다. 검토와 최종 승인 각각 자체 테스트 네 파일 및 canonical 품질 보고서를 native read로 읽었다. 보호 파일 6개, Test 입력 snapshot 18개, 브라우저 소스 및 실행 dist 191개의 무결성을 확인했고 Test 역할의 실제 소스 변경은 0회다. 기능 기준 21개와 범위 감사 추가 기준 2개가 모두 충족돼 최종 평가 **PASS(23/23)**다.

원시 native 로그와 엔진 감사를 교차 확인한 결과 시도 15개의 관찰 가능한 파일/조회 이벤트 **151개**, 실행 전 차단 **4건**, 실제 대상 밖 native 조회 **0건**, 미확정 조회 **0건**, 감사 누락/파싱 오류 **0건**이며 집계가 일치한다. 다만 임의 프로그램·MCP·plugin 내부 I/O를 격리하는 OS 샌드박스는 아니다. 구현 진단의 Node 검사에 `/tmp/ctrl.json`, `/tmp/eng.json` 출력 경로를 넘긴 완료 명령 2건도 별도로 보존했다. 이 프로그램 I/O를 native 조회 0건의 증거에 포함하지 않으며 모든 파일 접근이 대상 내부에 있었다고 확대 해석하지 않는다. 무료 메타데이터와 라우팅은 관찰했으나 실제 청구액·공급자 내부 요청/토큰 및 모든 목표의 무인 완주를 보장하지 않는다.

자연 SUCCESS 뒤 workflow stop 요청 없이 소유 관리 서버를 종료했다. 기록 PID **163개**·포트 **9개**가 모두 종료됐고 해당 실행 폴더 cwd 잔류 프로세스는 0개다. 정리 전후 SUCCESS 상태도 유지했다. 상세 자료: `/Users/supercent/Desktop/agent graph test/kilo-native-scope-final-20261025-144406/TEST_RESULTS.md`, `RESULTS.json`, `FINDINGS.md`, `results/native-scope-audit.json`, `results/program-io-observations.json`, `results/cleanup-verification.json`. 사용자 홈 인증 설정과 과거 세션 로그는 수집하지 않았다.

첫 개발 시험 `b2bb4a7c-879c-44ed-82e4-91f0a4a761bd` / `3983c0850d43f7a0926f4ac4c446ffe513a48758`는 정상 조회/공백 절대 경로 오차단 때문에 고정 마감에 **PAUSED / NOT_SUCCESS**로 끝났다(약 42분·17호출·수동 제어 0회). 범위 감사 17개/원시 이벤트 132개는 일치했고 실행 전 차단 1건·실제 외부 조회 0건이었지만 Test·검토·최종 승인은 미완료였다. 기록 PID 161개·포트 10개도 정리했다. 이 실패를 성공으로 세지 않고 구문 처리를 보완해 전체 회귀 검사를 다시 통과한 뒤 위 별도 빈 프로젝트로 재검증했다. 첫 시험 보고서는 `/Users/supercent/Desktop/agent graph test/kilo-native-scope-20261025-134908/TEST_RESULTS.md`에 보존한다.
