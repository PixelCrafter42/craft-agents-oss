# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- **Employee session board** — See conversations in adaptive employee swimlanes that wrap across rows as the team grows, spot active work at a glance, and drag cards between employees (or into the unassigned lane) to update ownership.
- **Employee avatars** — Add a custom rounded-rectangle avatar for each employee and see it consistently in employee settings, session badges, menus, and board columns.
- **Unread session filter** — Narrow any conversation list to unread sessions from the existing filter menu, with the choice remembered independently for each view.
- **Messaging-bound session discovery** — Agents can now find sessions by Telegram, Weixin, WhatsApp, or Lark binding in one read-only query, including exact channel and Telegram topic details for reliable automation handoffs.

## Improvements

## Bug Fixes

- **OAuth fallback handles missing subscription credentials and attachment-only messages** — Missing OAuth credentials now refresh before model fallback, image-only turns can retry without requiring text, and failed automation turns are recorded as failures instead of successful dispatches.
- **Weixin proactive delivery survives stale conversation tokens** — Scheduled automations and other outbound messages now clear an expired per-chat context token and retry once without it, so reinstalling or restarting Craft Agents no longer requires the user to message the bot before pushes resume.

## Breaking Changes
