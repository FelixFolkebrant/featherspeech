import { z } from "zod";

export const appearanceSchema = z
  .object({
    theme: z.enum(["neutral", "blue", "forest", "plum"]),
    background: z.enum(["transparent", "solid"]),
  })
  .strict();
export type Appearance = z.infer<typeof appearanceSchema>;
export const defaultAppearance: Appearance = {
  theme: "neutral",
  background: "transparent",
};
export const defaultTestSpeech =
  "Hello! This is my voice. How does this pace sound to you?";
