import type { TtsVoice } from "@poke/domain";

/**
 * AssemblyAI-TTS-1's named voices (docs/tts/voices, read 2026-11). AssemblyAI has no API that
 * lists voices, only a dashboard catalog, so Settings offers these; a cloned voice's id can be
 * set by hand (`voice.id`).
 */
export const VOICES: TtsVoice[] = [
  { id: "aai-kyla", name: "Kyla", language: "English (US)", description: "Young woman, quick" },
  { id: "aai-aaliyah", name: "Aaliyah", language: "English (US)", description: "Young woman, bright" },
  { id: "aai-annabelle", name: "Annabelle", language: "English (US)", description: "Young woman, high" },
  { id: "aai-april", name: "April", language: "English (US)", description: "Young woman, fast" },
  { id: "aai-audrey", name: "Audrey", language: "English (US)", description: "Woman, even" },
  { id: "aai-ernest", name: "Ernest", language: "English (US)", description: "Man, fast" },
  { id: "aai-ewald", name: "Ewald", language: "English (US)", description: "Man, brisk" },
  { id: "aai-hailey", name: "Hailey", language: "English (US)", description: "Young woman, brisk" },
  { id: "aai-peter", name: "Peter", language: "English (US)", description: "Man, soft-spoken" },
  { id: "aai-sara", name: "Sara", language: "English (US)", description: "Young woman, even" },
  { id: "aai-titus", name: "Titus", language: "English (US)", description: "Young man, deep" },
  { id: "aai-buford", name: "Buford", language: "English (UK)", description: "Older man, lively" },
  { id: "aai-carrie", name: "Carrie", language: "English (UK)", description: "Woman, soft-spoken" },
  { id: "aai-cloyd", name: "Cloyd", language: "English (UK)", description: "Older man, energetic" },
  { id: "aai-lilla", name: "Lilla", language: "English (UK)", description: "Woman, expressive" },
  { id: "aai-nancy", name: "Nancy", language: "English (UK)", description: "Woman, even" },
  { id: "aai-percival", name: "Percival", language: "English (UK)", description: "Older man, lively" },
  { id: "aai-yasmin", name: "Yasmin", language: "English (UK)", description: "Woman, expressive" },
  { id: "aai-steven", name: "Steven", language: "English (Australia)", description: "Man, even" },
  { id: "aai-troy", name: "Troy", language: "English (Scotland)", description: "Young man, deep, soft" },
  { id: "aai-abdiel", name: "Abdiel", language: "English", description: "Older man, breathy" },
  { id: "aai-dorsey", name: "Dorsey", language: "English", description: "Older man, raspy" },
  { id: "aai-gunnar", name: "Gunnar", language: "English", description: "Older man, unhurried" },
  { id: "aai-antonioluis", name: "Antonio Luis", language: "Spanish (Mexico)", description: "Man, deep" },
  { id: "aai-constanza", name: "Constanza", language: "Spanish (Mexico)", description: "Young woman, even" },
  { id: "aai-malvina", name: "Malvina", language: "Spanish (Mexico)", description: "Woman, soft-spoken" },
  { id: "aai-oriol", name: "Oriol", language: "Spanish (Mexico)", description: "Man, brisk" },
  { id: "aai-magdalena", name: "Magdalena", language: "German", description: "Young woman, deep" },
  { id: "aai-gunther", name: "Günther", language: "German", description: "Man, expressive, soft" },
  { id: "aai-jorg", name: "Jörg", language: "German", description: "Man, even" },
  { id: "aai-giada", name: "Giada", language: "Italian", description: "Young woman, clear" },
  { id: "aai-donatien", name: "Donatien", language: "French", description: "Man, soft, expressive" },
  { id: "aai-benicio", name: "Benício", language: "Portuguese", description: "Young man, balanced" },
  { id: "aai-nelson", name: "Nelson", language: "Portuguese (Brazil)", description: "Older man, deep" },
];
