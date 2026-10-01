import type { Locale } from './types';

interface ProjectCopy {
  identityTitle: string;
  identityBody: string;
  philosophyTitle: string;
  sourceTitle: string;
  sourceBody: string;
  sourceAction: string;
  updatesTitle: string;
  updatesBody: string;
  updatesAction: string;
  contactTitle: string;
  contactBody: string;
  supportTitle: string;
  questionsTitle: string;
  questionsBody: string;
  questionsAction: string;
  privateTitle: string;
  privateBody: string;
  emailAction: string;
  guidesTitle: string;
}

export const projectCopy: Record<Locale, ProjectCopy> = {
  'zh-CN': {
    identityTitle: '为漫画阅读与翻译而做的开源项目。',
    identityBody: 'NodeLane Comics 的源码与问题记录公开于 GitHub，项目代码采用 GPL-3.0-only 许可证。你可以查看实现、跟进版本变化，并通过官方渠道联系维护者。',
    philosophyTitle: '让阅读更连贯',
    sourceTitle: '项目源码',
    sourceBody: '查看源代码、问题记录与 GPL-3.0-only 许可证。',
    sourceAction: '查看 GitHub 项目',
    updatesTitle: '版本更新',
    updatesBody: '了解已发布版本的功能变化与修复。',
    updatesAction: '查看更新日志',
    contactTitle: '联系维护者',
    contactBody: '使用、账户与隐私问题可通过官方邮箱联系。',
    supportTitle: '选择合适的支持渠道',
    questionsTitle: '常规问题与功能建议',
    questionsBody: '通过 GitHub Issues 提交可公开的报错与建议，请附上浏览器和插件版本、复现步骤。',
    questionsAction: '打开 GitHub Issues',
    privateTitle: '账户、账单与隐私请求',
    privateBody: '请邮件联系，只提供必要的脱敏信息。账户与支付资料请勿发布在公开问题中。',
    emailAction: '发送邮件',
    guidesTitle: '操作与排查指南',
  },
  'zh-TW': {
    identityTitle: '為漫畫閱讀與翻譯而做的開源專案。',
    identityBody: 'NodeLane Comics 的原始碼與問題紀錄公開於 GitHub，專案程式碼採用 GPL-3.0-only 授權。你可以查看實作、追蹤版本變化，並透過官方管道聯絡維護者。',
    philosophyTitle: '讓閱讀更連貫',
    sourceTitle: '專案原始碼',
    sourceBody: '查看原始碼、問題紀錄與 GPL-3.0-only 授權。',
    sourceAction: '查看 GitHub 專案',
    updatesTitle: '版本更新',
    updatesBody: '了解已發布版本的功能變化與修正。',
    updatesAction: '查看更新紀錄',
    contactTitle: '聯絡維護者',
    contactBody: '使用、帳戶與隱私問題可透過官方信箱聯絡。',
    supportTitle: '選擇適合的支援管道',
    questionsTitle: '一般問題與功能建議',
    questionsBody: '透過 GitHub Issues 提交可公開的錯誤與建議，請附上瀏覽器和擴充功能版本、重現步驟。',
    questionsAction: '開啟 GitHub Issues',
    privateTitle: '帳戶、帳單與隱私請求',
    privateBody: '請以電子郵件聯絡，只提供必要且已去識別的資訊。帳戶與付款資料請勿發布於公開問題中。',
    emailAction: '傳送電子郵件',
    guidesTitle: '操作與疑難排解指南',
  },
  en: {
    identityTitle: 'An open source reading and translation project.',
    identityBody: 'NodeLane Comics is maintained by the project maintainers, with source code and issues published on GitHub. Project code is licensed under GPL-3.0-only. Follow releases and contact the maintainers through the official channels below.',
    philosophyTitle: 'Keep the story flowing',
    sourceTitle: 'Source code',
    sourceBody: 'Explore the code, issue tracker, and GPL-3.0-only license.',
    sourceAction: 'View the GitHub project',
    updatesTitle: 'Release updates',
    updatesBody: 'See features and fixes in published releases.',
    updatesAction: 'Read the changelog',
    contactTitle: 'Contact the maintainers',
    contactBody: 'Use the official email for product, account, and privacy questions.',
    supportTitle: 'Choose a support channel',
    questionsTitle: 'General questions and suggestions',
    questionsBody: 'Report public bugs and suggestions through GitHub Issues. Include browser and extension versions and steps to reproduce.',
    questionsAction: 'Open GitHub Issues',
    privateTitle: 'Account, billing, and privacy requests',
    privateBody: 'Contact us by email with only the necessary, redacted details. Keep account and payment information out of public issues.',
    emailAction: 'Send an email',
    guidesTitle: 'Setup and troubleshooting guides',
  },
  ja: {
    identityTitle: '漫画を読む、翻訳するためのオープンソースプロジェクト。',
    identityBody: 'NodeLane Comics のソースコードと課題は GitHub で公開しています。プロジェクトのコードは GPL-3.0-only ライセンスです。実装やリリース内容を確認し、以下の公式窓口からメンテナーに連絡できます。',
    philosophyTitle: '物語を途切れさせないために',
    sourceTitle: 'ソースコード',
    sourceBody: 'コード、課題、GPL-3.0-only ライセンスを確認できます。',
    sourceAction: 'GitHub プロジェクトを見る',
    updatesTitle: 'バージョン更新',
    updatesBody: '公開済みリリースの機能変更と修正を確認できます。',
    updatesAction: '更新履歴を見る',
    contactTitle: 'メンテナーへの連絡',
    contactBody: '使い方、アカウント、プライバシーの質問は公式メールへ。',
    supportTitle: 'お問い合わせ内容に合った窓口',
    questionsTitle: '一般的な質問と機能の提案',
    questionsBody: '公開できる不具合や提案は GitHub Issues へ。ブラウザーと拡張機能のバージョン、再現手順を添えてください。',
    questionsAction: 'GitHub Issues を開く',
    privateTitle: 'アカウント、請求、プライバシーの依頼',
    privateBody: '必要な情報だけを、機密情報を伏せてメールでお送りください。アカウントや支払い情報は公開の課題に記載しないでください。',
    emailAction: 'メールを送る',
    guidesTitle: '操作とトラブル解決のガイド',
  },
  ko: {
    identityTitle: '프로젝트 관리자가 유지 관리하는 오픈 소스 프로젝트입니다.',
    identityBody: 'NodeLane Comics의 소스 코드와 이슈는 GitHub에 공개되어 있습니다. 프로젝트 코드는 GPL-3.0-only 라이선스를 따릅니다. 구현과 출시 내역을 확인하고 아래 공식 채널로 관리자에게 문의할 수 있습니다.',
    philosophyTitle: '이야기에 계속 집중할 수 있도록',
    sourceTitle: '소스 코드',
    sourceBody: '코드, 이슈 및 GPL-3.0-only 라이선스를 확인하세요.',
    sourceAction: 'GitHub 프로젝트 보기',
    updatesTitle: '버전 업데이트',
    updatesBody: '출시된 버전의 기능 변경과 수정 사항을 확인하세요.',
    updatesAction: '업데이트 내역 보기',
    contactTitle: '관리자에게 문의',
    contactBody: '사용, 계정 및 개인정보 관련 질문은 공식 이메일로 문의하세요.',
    supportTitle: '문의에 맞는 지원 채널 선택',
    questionsTitle: '일반 문제와 기능 제안',
    questionsBody: '공개 가능한 오류와 제안은 GitHub Issues에 등록하세요. 브라우저와 확장 프로그램 버전, 재현 단계를 함께 적어 주세요.',
    questionsAction: 'GitHub Issues 열기',
    privateTitle: '계정, 결제 및 개인정보 요청',
    privateBody: '민감한 내용을 가린 뒤 필요한 정보만 이메일로 보내 주세요. 계정과 결제 정보는 공개 이슈에 올리지 마세요.',
    emailAction: '이메일 보내기',
    guidesTitle: '사용 및 문제 해결 가이드',
  },
};
