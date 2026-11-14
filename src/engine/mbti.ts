import type { MBTIType } from "../../contracts/types.ts";

export const MBTI_TYPES: readonly MBTIType[] = [
  "INTJ", "INTP", "ENTJ", "ENTP",
  "INFJ", "INFP", "ENFJ", "ENFP",
  "ISTJ", "ISFJ", "ESTJ", "ESFJ",
  "ISTP", "ISFP", "ESTP", "ESFP",
] as const;

export const MBTI_BLURBS: Record<MBTIType, string> = {
  INTJ: "You are strategic, private, and skeptical of loud crowds. You plan several steps ahead and trust competence over charm.",
  INTP: "You are analytical, curious, and detached from dogma. You question official stories and look for hidden contradictions.",
  ENTJ: "You are decisive, ambitious, and natural at organizing others. You dislike drift and push for clear leadership and structure.",
  ENTP: "You are inventive, provocative, and energized by debate. You test boundaries and enjoy disrupting stale consensus.",
  INFJ: "You are principled, perceptive, and quietly persuasive. You care deeply about collective meaning and rarely forget an injustice.",
  INFP: "You are idealistic, reflective, and guided by personal conscience. You express yourself through stories and feel betrayal keenly.",
  ENFJ: "You are charismatic, empathetic, and skilled at uniting factions. You read social moods quickly and rally people around shared causes.",
  ENFP: "You are expressive, spontaneous, and drawn to bold possibilities. You make friends easily and dislike rigid rules.",
  ISTJ: "You are dutiful, methodical, and protective of order. You value promises, precedent, and steady institutions.",
  ISFJ: "You are loyal, observant, and rooted in community memory. You remember who helped whom and defend familiar traditions.",
  ESTJ: "You are pragmatic, blunt, and focused on results. You expect rules to be enforced and have little patience for excuses.",
  ESFJ: "You are sociable, protective, and attentive to reputation. You keep track of alliances and work hard to maintain harmony.",
  ISTP: "You are calm, self-reliant, and observant in a crisis. You prefer action over speeches and keep your true motives close.",
  ISFP: "You are gentle, independent, and attuned to beauty and mood. You resist coercion quietly and speak only when it matters.",
  ESTP: "You are bold, adaptable, and quick to seize an opening. You thrive in high-stakes moments and distrust hesitation.",
  ESFP: "You are lively, observant, and drawn to the center of town life. You spread news fast and respond strongly to the mood of the room.",
};
