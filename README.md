# FAIR CHZZK DRAW

치지직 채팅 참여자를 대상으로 추첨하는 Cloudflare Pages용 웹 앱입니다.

## 주요 기능

- 치지직 채널 URL 또는 채널 ID 등록
- 채팅 참여자 모집, 구독자 전용 추첨, 기존 당첨자 제외
- 당첨자 전용 채팅창 표시 및 한국어 기본 음성 TTS 재생

## 공정 추첨 방식

- 브라우저 Web Crypto API의 `crypto.getRandomValues()` 사용
- rejection sampling으로 모듈로 편향 제거
- Fisher-Yates 알고리즘으로 후보 전체 셔플
- 셔플된 배열의 첫 번째 참여자를 당첨자로 선정

슬롯 UI는 결과를 보여주는 애니메이션입니다. 당첨자는 애니메이션 시작 전에
공정 추첨 엔진에서 결정됩니다.
