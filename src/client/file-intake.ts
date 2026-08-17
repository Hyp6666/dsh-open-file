import { OpenFileError } from "../errors.js";

const NATIVE_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export interface PartitionedAttachmentFiles {
  readonly nativeImages: readonly File[];
  readonly ordinaryFiles: readonly File[];
}

export interface NativeImageSink {
  add(files: readonly File[]): void;
}

export interface OrdinaryFileQueue {
  enqueue(sessionId: string, files: Iterable<File>): readonly string[] | void;
}

export function partitionAttachmentFiles(files: Iterable<File>): PartitionedAttachmentFiles {
  const nativeImages: File[] = [];
  const ordinaryFiles: File[] = [];
  for (const file of files) {
    (NATIVE_IMAGE_MIME_TYPES.has(file.type.toLocaleLowerCase())
      ? nativeImages
      : ordinaryFiles).push(file);
  }
  return Object.freeze({
    nativeImages: Object.freeze(nativeImages),
    ordinaryFiles: Object.freeze(ordinaryFiles),
  });
}

export class FileIntakeCoordinator {
  private readonly nativeImageSinks = new Map<string, NativeImageSink>();

  constructor(private readonly queue: OrdinaryFileQueue) {}

  registerNativeImageSink(sessionId: string, sink: NativeImageSink): () => void {
    this.nativeImageSinks.set(sessionId, sink);
    return () => {
      if (this.nativeImageSinks.get(sessionId) === sink) {
        this.nativeImageSinks.delete(sessionId);
      }
    };
  }

  accept(sessionId: string, files: Iterable<File>): void {
    const partitioned = partitionAttachmentFiles(files);
    const sink = this.nativeImageSinks.get(sessionId);
    if (partitioned.nativeImages.length > 0 && sink === undefined) {
      throw new OpenFileError(
        "FILE_WEB_COMPATIBILITY",
        "DSH rc.6 native image draft input does not match the supported contract.",
      );
    }
    if (partitioned.nativeImages.length > 0) sink?.add(partitioned.nativeImages);
    if (partitioned.ordinaryFiles.length > 0) {
      this.queue.enqueue(sessionId, partitioned.ordinaryFiles);
    }
  }
}
