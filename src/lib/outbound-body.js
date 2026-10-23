/**
 * Message bodies scripts/send.js posts to
 * `POST /conversations/{id}/messages`, built WITHOUT client_msg_id and
 * metadata — the caller adds both. Kept here (not in scripts/) so the shape,
 * and the agent-activity retry hash computed from it, have a test surface.
 *
 * cws-core SendMessageRequest body (current schema):
 *   { client_msg_id, type, content: {content_type, body, attachments}, parent_id?, mentions?, metadata? }
 */

import { looksLikeMarkdown } from './message.js';

/**
 * One text chunk. type is the message-level enum (AGENT_TEXT for agent
 * outbound text / markdown); content.content_type is the body serialization.
 * attachments is required (may be empty). parent_id goes on the first chunk
 * only, to avoid duplicate threading.
 */
export function buildTextBody({ text, mentions, replyTo, first = true }) {
  return {
    type: 'AGENT_TEXT',
    content: {
      content_type: looksLikeMarkdown(text) ? 'markdown' : 'text',
      body:         { text },
      attachments:  [],
    },
    ...(first && replyTo ? { parent_id: replyTo } : {}),
    ...(mentions ? { mentions } : {}),
  };
}

/**
 * An image / file message. cws-fe renders the card and caption from
 * content.body ({file_name, text}); an empty body shows a blank bubble.
 * attachments[].artifact_id must be the cws-as artifact id (falls back to the
 * media id only for backward compatibility).
 */
export function buildMediaBody({ kind, fileName, caption, artifactId, mediaId, mimeType, sizeBytes, replyTo }) {
  const contentType = kind === 'image' ? 'image' : 'file';
  return {
    type: kind === 'image' ? 'IMAGE' : 'FILE',
    content: {
      content_type: contentType,
      body:         { file_name: fileName || '', ...(caption ? { text: caption } : {}) },
      attachments: [{
        artifact_id:  artifactId || mediaId,
        file_name:    fileName || '',
        content_type: mimeType || '',
        size_bytes:   sizeBytes || 0,
      }],
    },
    ...(replyTo ? { parent_id: replyTo } : {}),
  };
}
