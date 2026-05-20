// Registry of whisper.cpp GGML models yCal knows how to install + use
// for transcription. The recorder's setup runner uses the entries to
// resolve a download URL; the post-meet.sh runner uses the `filename`
// field to point YCAL_WHISPER_MODEL at the right .bin under
// ~/.ycal/models/.
//
// Trade-offs you make picking one:
//   - q4/q5: smaller download + faster decode, mild accuracy loss on
//     proper nouns and code-switched English.
//   - q8:   near-FP16 accuracy at half the disk. Sweet spot for most
//           users. Same ballpark as large-v3-turbo's size.
//   - fp16: best accuracy, ~2× the disk + decode time.
//
// Adding a model: drop another object below. Setup will auto-pick it
// up. No code changes needed outside this file + the matching
// translations in the Settings UI.

export interface WhisperModelInfo {
  // Stable identifier, used as the UiSettings value.
  id: string;
  // Shown in the model picker.
  displayName: string;
  // One-liner shown under the radio.
  description: string;
  // Filename it lands as under ~/.ycal/models/. Includes the ggml-
  // prefix so a future user inspecting the dir can tell the format.
  filename: string;
  // Direct download URL — must serve a single .bin with the canonical
  // whisper.cpp GGML format.
  url: string;
  // For UI display + "is the download complete" sanity-checking.
  sizeBytes: number;
  // Marked in the UI with a "recommended" badge.
  recommended?: boolean;
}

export const WHISPER_MODELS: WhisperModelInfo[] = [
  {
    id: 'large-v3-turbo',
    displayName: 'Whisper large-v3-turbo',
    description:
      'OpenAI Whisper turbo fine-tune. Fast and accurate for English-dominant audio; handles modest amounts of foreign speech.',
    filename: 'ggml-large-v3-turbo.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
    sizeBytes: 1_624_555_275,
  },
  {
    id: 'breeze-asr-25-q8',
    displayName: 'Breeze ASR 25 — Q8 (中英混合)',
    description:
      'MediaTek\'s Whisper fine-tune for Traditional Chinese ↔ English code-switching. Q8 quantized — same disk footprint as the turbo model, much better at mixed-language meetings.',
    filename: 'ggml-breeze-asr-25-q8.bin',
    url: 'https://huggingface.co/alan314159/Breeze-ASR-25-whispercpp/resolve/main/ggml-model-q8_0.bin',
    sizeBytes: 1_656_129_708,
    recommended: true,
  },
  {
    id: 'breeze-asr-25-fp16',
    displayName: 'Breeze ASR 25 — FP16 (中英混合, highest quality)',
    description:
      'Same as Breeze Q8 but full FP16 precision. Best accuracy at the cost of ~2× the disk and a slower decode.',
    filename: 'ggml-breeze-asr-25-fp16.bin',
    url: 'https://huggingface.co/alan314159/Breeze-ASR-25-whispercpp/resolve/main/ggml-model.bin',
    sizeBytes: 3_094_623_708,
  },
  {
    id: 'breeze-asr-25-q5',
    displayName: 'Breeze ASR 25 — Q5 (中英混合, smaller)',
    description:
      'Q5 quantized Breeze ASR. ~1 GB on disk, fastest decode in the Breeze family with a small accuracy hit vs Q8.',
    filename: 'ggml-breeze-asr-25-q5.bin',
    url: 'https://huggingface.co/alan314159/Breeze-ASR-25-whispercpp/resolve/main/ggml-model-q5_k.bin',
    sizeBytes: 1_080_732_108,
  },
  {
    id: 'breeze-asr-25-q4',
    displayName: 'Breeze ASR 25 — Q4 (中英混合, smallest)',
    description:
      'Q4 quantized Breeze ASR. ~850 MB. Pick this if disk space is the bottleneck.',
    filename: 'ggml-breeze-asr-25-q4.bin',
    url: 'https://huggingface.co/alan314159/Breeze-ASR-25-whispercpp/resolve/main/ggml-model-q4_k.bin',
    sizeBytes: 888_932_908,
  },
];

// Backwards-compatible default: the old hard-coded large-v3-turbo
// model. Existing settings.json files without a recordingWhisperModel
// field continue to use this — no auto-switch + no surprise re-download
// on upgrade.
export const DEFAULT_WHISPER_MODEL_ID = 'large-v3-turbo';

export function getModelById(id: string | null | undefined): WhisperModelInfo {
  if (id) {
    const found = WHISPER_MODELS.find((m) => m.id === id);
    if (found) return found;
  }
  return WHISPER_MODELS.find((m) => m.id === DEFAULT_WHISPER_MODEL_ID) ?? WHISPER_MODELS[0];
}
