/** "none": never a body, never a Content-Type (even for POST). */
export function encode() { return { contentType: undefined, body: undefined }; }
