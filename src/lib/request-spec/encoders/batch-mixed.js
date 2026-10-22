/** "batch_mixed": the outer multipart/mixed batch body (see ../batch.js). */
import { packBatch } from '../batch.js';

export function encode({ items, boundary }) { return packBatch(items, { boundary }); }
