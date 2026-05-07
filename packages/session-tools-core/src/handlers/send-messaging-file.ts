import { isAbsolute, resolve } from 'node:path';
import type { MessagingFilePlatform, SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';

export interface SendMessagingFileArgs {
  path: string;
  name?: string;
  caption?: string;
  platform?: MessagingFilePlatform;
  channelId?: string;
  threadId?: number;
}

export async function handleSendMessagingFile(
  ctx: SessionToolContext,
  args: SendMessagingFileArgs,
): Promise<ToolResult> {
  if (!ctx.sendMessagingFile) {
    return errorResponse('send_messaging_file is not available in this context.');
  }

  const rawPath = args.path?.trim();
  if (!rawPath) {
    return errorResponse('path is required.');
  }

  const filePath = isAbsolute(rawPath)
    ? rawPath
    : resolve(ctx.workingDirectory ?? ctx.workspacePath, rawPath);

  try {
    const sent = await ctx.sendMessagingFile({
      path: filePath,
      name: args.name,
      caption: args.caption,
      platform: args.platform,
      channelId: args.channelId,
      threadId: args.threadId,
    });

    const topicSuffix = sent.threadId !== undefined ? ` topic ${sent.threadId}` : '';
    return successResponse(
      `Sent ${sent.fileName} to ${sent.platform} channel ${sent.channelId}${topicSuffix}.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to send messaging file: ${message}`);
  }
}
