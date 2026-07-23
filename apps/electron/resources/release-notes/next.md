# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- **Employee session board** — See conversations in adaptive employee swimlanes that wrap across rows as the team grows, spot active work at a glance, and drag cards between employees (or into the unassigned lane) to update ownership.
- **Employee avatars** — Add a custom rounded-rectangle avatar for each employee and see it consistently in employee settings, session badges, menus, and board columns.
- **Unread conversations view and filter** — Open unread conversations directly from the primary sidebar, or narrow any conversation list from the existing filter menu; secondary filter choices remain remembered independently for each view.
- **Messaging-bound session discovery** — Agents can now find sessions by Telegram, Weixin, WhatsApp, or Lark binding in one read-only query, including exact channel and Telegram topic details for reliable automation handoffs.
- **Telegram private group interactions and richer AI replies** — Group commands, button acknowledgements, access denials, and status replies now prefer participant-only ephemeral messages, while AI responses can use structured rich blocks and embedded media with automatic fallback when Telegram rejects the richer delivery path.

## Improvements

- **Feishu and Lark AI-native conversations** — Feishu/Lark now use the official Channel and CardKit stack for reconnect-safe long connections, one-card streaming progress, Schema 2.0 Markdown, contextual and private group replies, richer media, secure approval callbacks, and one-click app creation or permission repair with graceful plain-message fallback.

## Bug Fixes

- **OAuth fallback handles missing subscription credentials and attachment-only messages** — Missing OAuth credentials now refresh before model fallback, image-only turns can retry without requiring text, and failed automation turns are recorded as failures instead of successful dispatches.
- **xAI connection validation detects revoked refresh tokens** — Validating an xAI/Grok connection now performs a real OAuth refresh, securely persists rotated credentials, and fails immediately when re-authentication is required instead of reporting a stale stored token as valid and discovering the problem only after a conversation starts.
- **Telegram native voice messages remain valid audio** — Telegram microphone voice notes now stay byte-exact Ogg/Opus attachments, use the `.oga` audio type, and expose their durable session path so agents can pass them to ASR tools without CRC or unexpected-EOF failures.
- **Telegram keeps receiving during long agent turns** — Incoming updates no longer wait for the current model and tool run to finish before polling continues, preventing later messages from appearing stuck behind a slow conversation.
- **Feishu/Lark message media downloads correctly** — Native voice notes, images, videos, and files now use the message-scoped resource API, preserve binary bytes and media metadata, and reach session attachments instead of appearing only as `file_v3` or `img_v3` placeholder text.
- **Pi provider retries keep delivering replies** — Recoverable rate-limit, server, and WebSocket failures now keep the active turn open while Pi retries, suppress transient errors after recovery, and deliver the eventual response to desktop and messaging clients instead of closing the stream early.
- **Weixin proactive delivery survives stale conversation tokens** — Scheduled automations and other outbound messages now clear an expired per-chat context token and retry once without it, so reinstalling or restarting Craft Agents no longer requires the user to message the bot before pushes resume.

## Breaking Changes
