import { z } from "zod";

export const NationSchema = z.enum(["lyrians", "skalians", "ventrians"]);
export const WorkKindSchema = z.enum(["poem", "song", "meme", "slogan", "anthem"]);

export const MoveActionSchema = z.object({
  type: z.literal("move"),
  region: z.string().min(1),
});

export const PostActionSchema = z.object({
  type: z.literal("post"),
  text: z.string().min(1),
});

export const ReplyActionSchema = z.object({
  type: z.literal("reply"),
  post_id: z.string().min(1),
  text: z.string().min(1),
});

export const DmActionSchema = z.object({
  type: z.literal("dm"),
  to: z.string().min(1),
  text: z.string().min(1),
});

export const LikeActionSchema = z.object({
  type: z.literal("like"),
  target_id: z.string().min(1),
});

export const VoteActionSchema = z.object({
  type: z.literal("vote"),
  candidate_id: z.string().nullable(),
});

export const FoundPartyActionSchema = z.object({
  type: z.literal("found_party"),
  name: z.string().min(1),
  manifesto: z.string().min(1),
});

export const JoinPartyActionSchema = z.object({
  type: z.literal("join_party"),
  party_id: z.string().min(1),
});

export const LeavePartyActionSchema = z.object({
  type: z.literal("leave_party"),
});

export const EndorseActionSchema = z.object({
  type: z.literal("endorse"),
  candidate_id: z.string().min(1),
});

export const DeclareIndependenceActionSchema = z.object({
  type: z.literal("declare_independence"),
  region: z.string().min(1),
});

export const SetCurriculumActionSchema = z.object({
  type: z.literal("set_curriculum"),
  text: z.string().min(1),
});

export const SetBorderActionSchema = z.object({
  type: z.literal("set_border"),
  region: z.string().min(1),
  blocked: z.union([z.literal("all"), z.array(NationSchema)]),
});

export const SetCensorshipActionSchema = z.object({
  type: z.literal("set_censorship"),
  mute_agents: z.array(z.string()),
  banned_phrases: z.array(z.string()),
});

export const SetVotingRightsActionSchema = z.object({
  type: z.literal("set_voting_rights"),
  nation: NationSchema,
  allowed: z.boolean(),
});

export const CedeRegionActionSchema = z.object({
  type: z.literal("cede_region"),
  region: z.string().min(1),
  to_nation: NationSchema,
});

export const AdoptAnthemActionSchema = z.object({
  type: z.literal("adopt_anthem"),
  work_id: z.string().min(1),
});

export const DecreeActionSchema = z.object({
  type: z.literal("decree"),
  text: z.string().min(1),
});

export const AnyActionSchema = z.discriminatedUnion("type", [
  MoveActionSchema,
  PostActionSchema,
  ReplyActionSchema,
  DmActionSchema,
  LikeActionSchema,
  VoteActionSchema,
  FoundPartyActionSchema,
  JoinPartyActionSchema,
  LeavePartyActionSchema,
  EndorseActionSchema,
  DeclareIndependenceActionSchema,
  SetCurriculumActionSchema,
  SetBorderActionSchema,
  SetCensorshipActionSchema,
  SetVotingRightsActionSchema,
  CedeRegionActionSchema,
  AdoptAnthemActionSchema,
  DecreeActionSchema,
]);

export type AgentAction = z.infer<typeof AnyActionSchema>;

export const MorningOutputSchema = z.object({
  private_thought: z.string(),
  actions: z.array(AnyActionSchema),
});

export type MorningOutput = z.infer<typeof MorningOutputSchema>;

export interface AllowedActionOptions {
  canMove: boolean;
  canVote: boolean;
  isPartyLeader: boolean;
  canDeclareIndependence: boolean;
  isPresident: boolean;
}

export function buildAllowedMorningSchema(opts: AllowedActionOptions): z.ZodType<MorningOutput> {
  const allowed: z.ZodTypeAny[] = [
    PostActionSchema,
    ReplyActionSchema,
    DmActionSchema,
    LikeActionSchema,
    FoundPartyActionSchema,
    JoinPartyActionSchema,
    LeavePartyActionSchema,
  ];
  if (opts.canMove) allowed.push(MoveActionSchema);
  if (opts.canVote) allowed.push(VoteActionSchema);
  if (opts.isPartyLeader) allowed.push(EndorseActionSchema);
  if (opts.canDeclareIndependence) allowed.push(DeclareIndependenceActionSchema);
  if (opts.isPresident) {
    allowed.push(
      SetCurriculumActionSchema,
      SetBorderActionSchema,
      SetCensorshipActionSchema,
      SetVotingRightsActionSchema,
      CedeRegionActionSchema,
      AdoptAnthemActionSchema,
      DecreeActionSchema
    );
  }
  return z.object({
    private_thought: z.string(),
    actions: z.array(
      z.discriminatedUnion("type", allowed as [z.ZodDiscriminatedUnionOption<"type">, ...z.ZodDiscriminatedUnionOption<"type">[]])
    ),
  }) as unknown as z.ZodType<MorningOutput>;
}

export const LocalChatOutputSchema = z.object({
  private_thought: z.string(),
  say: z.string().nullable(),
});

export type LocalChatOutput = z.infer<typeof LocalChatOutputSchema>;

export const EveningOutputSchema = z.object({
  private_thought: z.string(),
  diary: z.string().min(1),
  work: z
    .object({
      kind: WorkKindSchema,
      text: z.string().min(1),
    })
    .nullable()
    .optional(),
  will: z.string().nullable().optional(),
});

export type EveningOutput = z.infer<typeof EveningOutputSchema>;

export const GenesisOutputSchema = z.object({
  backstory: z.string().min(1),
  worldview: z.string().min(1),
});

export type GenesisOutput = z.infer<typeof GenesisOutputSchema>;

export const WorldviewOutputSchema = z.object({
  worldview: z.string().min(1),
});

export type WorldviewOutput = z.infer<typeof WorldviewOutputSchema>;
