// request_spec examples from plan §6 (v2), used by the engine tests.
export const COMPOSE_SEND = {
  version: 1,
  requires: ['body_template', 'file_source'],
  encoding: 'json',
  files: { attachments: { multiple: true, max_bytes: 20971520, max_total_bytes: 24117248, sources: ['path', 'artifact', 'base64', 'text'] } },
  body: {
    raw: { $first: ['{{raw}}', { $pipe: [{ $rfc822: { from: '{{from}}', to: '{{to}}', cc: '{{cc}}', bcc: '{{bcc}}', reply_to: '{{reply_to}}', subject: '{{subject}}', text: '{{text}}', html: '{{html}}', attachments: '{{attachments}}' } }, 'base64url'] }] },
    threadId: '{{thread_id}}',
  },
};

export const DRAFT_CREATE = {
  version: 1,
  requires: ['body_template', 'file_source'],
  encoding: 'json',
  files: { attachments: { multiple: true, max_total_bytes: 24117248 } },
  body: { message: { raw: { $pipe: [{ $rfc822: { to: '{{to}}', cc: '{{cc}}', bcc: '{{bcc}}', subject: '{{subject}}', text: '{{text}}', html: '{{html}}', attachments: '{{attachments}}' } }, 'base64url'] }, threadId: '{{thread_id}}' } },
};

export const REPLY = {
  version: 1,
  requires: ['body_template', 'prefetch', 'file_source'],
  encoding: 'json',
  prefetch: [{ as: 'orig', action: 'gmail/messages-get', params: { id: '{{message_id}}', format: 'metadata', _query: { metadataHeaders: ['Message-ID', 'References', 'Subject', 'From', 'Reply-To'] } } }],
  files: { attachments: { multiple: true, max_total_bytes: 24117248 } },
  body: {
    raw: { $pipe: [{ $rfc822: {
      to: { $first: ['{{to}}', "{{prefetch.orig.body.payload.headers | header('Reply-To')}}", "{{prefetch.orig.body.payload.headers | header('From')}}"] },
      cc: '{{cc}}', bcc: '{{bcc}}',
      subject: "{{prefetch.orig.body.payload.headers | header('Subject') | default('') | prefix_once('Re: ')}}",
      in_reply_to: "{{prefetch.orig.body.payload.headers | header('Message-ID')}}",
      references: "{{prefetch.orig.body.payload.headers | header('References') | default('')}} {{prefetch.orig.body.payload.headers | header('Message-ID')}}",
      text: '{{text}}', html: '{{html}}', attachments: '{{attachments}}',
    } }, 'base64url'] },
    threadId: '{{prefetch.orig.body.threadId}}',
  },
};

export const FORWARD = {
  version: 1,
  requires: ['body_template', 'prefetch', 'file_source'],
  encoding: 'json',
  prefetch: [
    { as: 'meta', action: 'gmail/messages-get', params: { id: '{{message_id}}', format: 'metadata', _query: { metadataHeaders: ['Subject'] } } },
    { as: 'raw', action: 'gmail/messages-get', params: { id: '{{message_id}}', format: 'raw' } },
  ],
  files: { attachments: { multiple: true, max_total_bytes: 24117248 } },
  body: {
    raw: { $pipe: [{ $rfc822: {
      to: '{{to}}', cc: '{{cc}}', bcc: '{{bcc}}',
      subject: "{{prefetch.meta.body.payload.headers | header('Subject') | default('') | prefix_once('Fwd: ')}}",
      text: '{{text}}', html: '{{html}}',
      attachments: { $concat: [[{ $bytes: '{{prefetch.raw.body.raw | base64url_decode}}', mime_type: 'message/rfc822', filename: 'forwarded.eml' }], '{{attachments}}'] },
    } }, 'base64url'] },
  },
};

export const DOCS_INSERT = {
  version: 1,
  requires: ['body_template'],
  encoding: 'json',
  body: { requests: [{ insertText: {
    text: '{{text}}',
    location: { $if: 'index', then: { index: '{{index}}', segmentId: '{{segment_id}}' } },
    endOfSegmentLocation: { $if: '!index', then: { segmentId: '{{segment_id}}' } },
  } }] },
};

export const DRIVE_UPLOAD = {
  version: 1,
  requires: ['body_template', 'file_source', 'file_upload'],
  encoding: 'multipart_related',
  files: { file: { max_bytes: 5242880, sources: ['path', 'artifact', 'base64', 'text'] } },
  parts: [
    { content_type: 'application/json; charset=UTF-8', body: { name: { $first: ['{{name}}', '{{files.file.filename}}'] }, parents: '{{parents}}', mimeType: '{{mime_type}}', description: '{{description}}' } },
    { file: 'file' },
  ],
};

export const DRIVE_UPDATE_CONTENT = {
  version: 1,
  requires: ['body_template', 'file_source', 'file_upload'],
  encoding: 'media',
  files: { file: { sources: ['path', 'artifact', 'base64', 'text'] } },
  body: { $bytes: '{{file}}' },
};

export const DRIVE_RESUMABLE = {
  version: 1,
  requires: ['body_template', 'file_source', 'resumable_upload'],
  encoding: 'json',
  files: { file: { stream: true, max_bytes: 1073741824, sources: ['path', 'artifact'] } },
  body: { name: { $first: ['{{name}}', '{{files.file.filename}}'] }, parents: '{{parents}}', mimeType: '{{mime_type}}' },
  upload: {
    init_headers: { 'X-Upload-Content-Type': '{{files.file.mime_type}}', 'X-Upload-Content-Length': '{{files.file.size}}' },
    session_url_from: 'header:Location', chunk_method: 'PUT', chunk_bytes: 8388608, chunk_multiple: 262144,
    range_style: 'content_range', incomplete_status: 308, progress_header: 'Range', status_probe: 'content_range_star',
    final_status: [200, 201], max_restarts: 1,
  },
};

export const CALENDAR_BATCH = {
  version: 1,
  requires: ['batch'],
  encoding: 'batch_mixed',
  batch: { items_param: 'requests', max_items: 50, allowed_actions: ['calendar/events-insert', 'calendar/events-patch', 'calendar/events-delete'], path_prefix: '/calendar/v3/', part_format: 'application_http' },
};
