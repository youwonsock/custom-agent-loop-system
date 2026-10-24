# 자율 제작·검증 실행

그래프 라이브러리의 **↻ 자율 제작 그래프**로 새 프리셋을 만든 뒤 CLI·모델·목표·대상 프로젝트를 지정한다. 이 프리셋은 계획 1개를 자동 선택하고, 구현 → 테스트 → 읽기 전용 검토 → 최종 승인으로 진행한다. 기존 그래프의 계획 승인 설정은 변경하지 않는다. CLI에서는 `agent-loop init --autonomous`로 같은 프리셋을 추가할 수 있다.

그래프 설정의 `자동 수정 루프`는 실패를 구현으로 되돌리며 기본 3회까지 수정한다. `실제 브라우저 검증 필수`가 켜진 웹 작업은 실제 플랫폼 검증 명령의 네이티브 종료 코드 0이 추가로 필요하다. 웹이 아닌 작업은 이 옵션을 끄고 해당 프로젝트의 실제 테스트를 사용한다. 빈 검사·보고서만 작성한 실행·생략·실패·낡은 근거로 SUCCESS를 만들지 않는다.

## 준비와 권한

- Node 24 이상과 인증된 로컬 코딩 CLI, 대상 프로젝트의 테스트 실행 환경이 필요하다.
- 웹 작업에는 `playwright`와 Chromium이 대상 프로젝트 또는 Agent Graph 설치 환경에 있어야 한다. 없으면 구현 역할이 기존 승인된 CLI 도구로 프로젝트 내부 설치를 준비할 수 있다. 설치·네트워크·권한이 거부되면 대기한다. npm 배포에 브라우저를 묶거나 자동으로 전역 설치하지 않는다.
- Codex의 `네이티브 자동 승인 검토`는 `--approve-for-me`를 지원하는 CLI에서만 사용한다. 쓰기 역할의 개별 명령을 네이티브 검토자가 승인하며 workspace-write를 사용한다. `--sandbox`와 충돌하는 인자를 함께 전달하지 않는다. 읽기 전용 역할에는 적용하지 않는다. 사용자 전역 CLI 설정은 바꾸지 않는다.
- Kilo 등 다른 CLI는 기존 네이티브 명령 승인 정책을 사용한다. 무인 실행 전에 필요한 프로젝트 명령이 해당 정책에서 허용돼 있어야 한다. 그래프는 인증·권한 거부·명시적 사람 승인을 자동 우회하지 않는다.

## 브라우저 검사 명세

구현/테스트 역할이 `.agent-graph/browser.json`을 작성한다. 검사 조건은 원래 요구사항을 충족해야 하며, 실패를 없애기 위해 명세·테스트를 약화하면 안 된다. 계획·검토·최종 승인 역할은 이 명세와 실제 테스트 기록을 읽기 전용으로 검토한다. 원래 사용자가 사람의 승인이나 운영자 전용 증거를 명시했다면 그 조건은 계속 지킨다. 자율 작업의 새 목표에는 불필요한 운영자 전용 보고서 조건을 추가하지 않는다.

```json
{
  "version": 1,
  "server": { "command": ["node", "server.mjs"] },
  "steps": [
    { "id": "desktop", "type": "viewport", "width": 1280, "height": 900 },
    { "id": "page", "type": "visible", "selector": "h1" },
    { "id": "move", "type": "click", "selector": "#move" },
    { "id": "score", "type": "text", "selector": "#score", "equals": "1" },
    { "id": "save", "type": "snapshot", "name": "score", "selector": "#score" },
    { "id": "reload", "type": "reload" },
    { "id": "persist", "type": "sameSnapshot", "name": "score", "selector": "#score" },
    { "id": "mobile", "type": "viewport", "width": 390, "height": 844 },
    { "id": "bounds", "type": "noOverflow" },
    { "id": "cells-fit", "type": "within", "selector": ".cell", "container": "#board" },
    { "id": "console", "type": "noConsoleErrors" }
  ]
}
```

지원 단계는 `viewport`, `click`, `press(key)`, `drag(selector,direction)`, `reload`, `visible`, `text(equals/contains)`, `count(equals)`, `noOverflow`, `within(selector,container)`, `snapshot(name,selector)`, `sameSnapshot`, `differentSnapshot`, `noConsoleErrors`, `http(path,status,contains)`이다. 모든 단계의 id는 고유해야 하고, 실제 assertion이 최소 하나 있어야 한다. 한 실행은 최대 100단계·120초, 파일 해시는 최대 10,000개를 허용한다. assertion은 최대 5초간 상태가 안정되는지 재확인한다. 소스 심볼릭 링크는 명시적인 프로젝트 복사본으로 풀어야 하며 제한을 넘으면 성공 대신 실패/대기로 끝난다. `http`는 경로를 미리 정규화하지 않는 실제 loopback HTTP 요청이므로 encoded traversal·잘못된 URL도 직접 검사할 수 있다. DOM mock은 브라우저 검증으로 인정하지 않는다.

서버 명령은 argv 배열이며 셸 래퍼 없이 대상 프로젝트에서 시작한다. 제공된 전용 임시 `PORT`를 사용하고 실제 `http://127.0.0.1:포트`를 출력해야 한다. 다른 포트를 출력하면 기존 서버를 재사용하지 않고 실패한다. 빌드가 필요한 프로젝트는 먼저 빌드해야 한다. 검사 중·서버 종료 중 소스가 바뀌면 다시 검사해야 한다. 브라우저 요청은 이 loopback origin으로 한정한다.

일반 수동 실행은 `agent-loop verify-browser --spec .agent-graph/browser.json`으로 가능하다. 자율 그래프는 프롬프트에 제공된 **설치된 플랫폼 CLI의 정확한 절대 경로 명령**을 실행해야 한다. 프로젝트가 만든 가짜 CLI나 `--help` 실행은 네이티브 브라우저 증거로 수락하지 않는다. 단위 검사를 먼저 실행한 뒤 브라우저 명령을 마지막에 실행한다. 디렉터리 생성·로그 읽기·보고 출력은 별도 호출로 하고, 검사 뒤에 echo·파이프·백그라운드 실행을 붙이지 않는다.

`verification/browser/<run-id>/`에 성공/실패별 report.json, 서버 로그, 최종/실패 화면, viewport 화면과 trace.zip을 보존한다. `verification/browser/report.json`은 최근 실행의 원자적 복사본이다. 보고서는 검증기가 직접 쓰며 모델이 작성하지 않는다. 새 검사를 실행해도 과거 실패 폴더를 덮어쓰지 않는다. 실행한 서버와 브라우저만 정리하며, 외부 서버는 종료하지 않는다. 실패·취소·정리 불확실·미실행 단계는 성공으로 승격하지 않는다.

## 실패·재시도

- 테스트 assertion 실패는 FAIL, 검토/승인 반려는 REJECTED로 구현에 돌아간다.
- 모델이 BLOCKED로 보고한 수정 가능한 코드/검사 준비 문제는 `BLOCKED_KIND: product` 또는 `BLOCKED_KIND: test_setup`과 실제 근거를 포함한다. 자율 그래프에서만 실패 경로로 돌린다. 기존 수동 그래프의 BLOCKED 동작은 유지한다.
- 실제 네이티브 권한 오류는 위 표식보다 우선하여 대기한다. 외부 서비스·인증·명시적인 사람 증거는 `BLOCKED_KIND: external`로 보고한다.
- 테스트 역할의 제품 파일 변경은 네이티브 변경 경로와 실행 전후 파일 해시로 감지해 반려한다. 테스트·검증 명세·로그는 별도 경로에서 작성하고, 제품 수정은 구현에서 수행한다. 빌드 산출물과 테스트 결과는 제품 수정 검사에서 제외하되 실제 브라우저 검증의 소스·자산 해시에는 빌드 산출물을 포함한다.
- 사용자 Interrupt/STOP, 수동 계획 승인, 추가 접근 승인, 무료/유료·미확인 모델의 기존 복구 한도는 유지한다. 무료도 무한 반복하지 않고 유료·가격 미확인은 공급자 한도에 도달하면 추가 호출을 멈춘다.
- 형식 보완은 현재 네이티브 실행 기록을 기준으로 한다. 기록이 없으면 새 검사를 실행하고, 실패 기록을 PASS로 바꾸지 않으며, 유효한 성공 기록이 있으면 파일 수정 없이 정확한 CHECK_COMMAND로 보고만 보완한다.

검증기는 실제 실행 여부와 관측된 assertion을 증명한다. 원래 목표에 충분한 검사인지, 모델이 구현을 올바르게 수정했는지는 별도의 테스트·검토·최종 승인 책임이다. 프리셋은 사람 검토를 가장하거나 공급자 가용성을 보장하지 않는다.
