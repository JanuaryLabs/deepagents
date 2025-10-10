import { writeFile } from 'node:fs/promises';

import { groq } from '@ai-sdk/groq';
import { tool } from 'ai';
import z from 'zod';

import { agent, instructions } from '../agent.ts';
import { printer } from '../stream_utils.ts';
import { execute } from '../swarm.ts';

const generator = agent({
  name: 'animated_svg_generator',
  // model: anthropic('claude-sonnet-4-20250514'),
  model: groq('qwen/qwen3-32b'),
  prompt: instructions({
    purpose: [
      'You are an expert SVG animator and graphic designer.',
      'Generate animated inline SVG graphics based on user requirements.',
      'The SVG animations are self-contained using CSS within <style> tags and avoid SMIL elements.',
      'Output ONLY the final SVG string that can be directly embedded in HTML.',
    ],
    routine: [
      'Analyze the user request and identify key visual elements and animation requirements.',
      'Design the SVG structure with appropriate dimensions and viewBox.',
      'ONLY if the result meets requirements, output the final SVG.',
      'Keep all references internal (url(#...) format)',
      'call the save_svg tool to save the SVG content to a file.',
    ],
  }),
  // toolChoice: { type: 'tool', toolName: 'save_svg' },
  tools: {
    save_svg: tool({
      description: 'Saves the generated SVG content to a file.',
      inputSchema: z.object({
        filename: z
          .string()
          .transform(() => 'animated_svg_output.svg')
          .describe('The name of the file to save the SVG content to.'),
        content: z.string().describe('The SVG content to be saved.'),
      }),
      async execute({ filename, content }) {
        await writeFile(filename, content, 'utf-8');
        return { success: true, message: `File saved as ${filename}` };
      },
    }),
  },
});

const result = execute(
  generator,
  //   `Design an animated SVG credit card box with the following features:
  // - A rectangular box with rounded corners representing a credit card.
  // - The box should have a gradient background transitioning from blue to purple.
  // - Include a simple chip design on the left side of the card.
  // - Add animated elements such as moving lines or shapes to give a dynamic feel.`,
  `Design an animated SVG employee identification card with the following specifications. Size: 350×220 (viewBox 0 0 350 220). Rounded corners 12px. Stroke 2px #e5e7eb. Subtle drop shadow.

Background & styling:
- Vertical gradient: #dcfce7 (top) → #dbeafe (bottom)
- Low‑opacity (~0.1) geometric pattern overlay
- Small company logo placeholder in top‑right

Layout:
- Left avatar column ~80px wide
- Avatar: circle 60px dia, vertically centered, bg #94a3b8, white 3px border, subtle shadow
- Right column:
  • Name “Alex Johnson” (18px bold #1f2937)
  • Employee ID “EMP-2024-5847” (14px #6b7280), ~10px below avatar top
  • Contact: “+1 (555) 123-4567”, “San Francisco, CA” (12px #374151), ~15px below ID
  • Project: label “CURRENT PROJECT:” (11px uppercase #6b7280); value “Digital Transformation Initiative” (12px medium #059669), ~15px below contact

Animations:
- Avatar pulse: gentle scale 1↔1.05; quick (~0.5s) every 3s
- Floating particles: 3–4 dots (r=2, #10b981) oscillate ±15px with varied 4–6s durations and staggered delays
- Shimmer sweep: diagonal (~45°), ~100px wide, subtle translucent white, left→right every 8s, clipped to card
- Project highlight: color shifts #059669↔#10b981 on a 5s cycle with ~1s transitions
- Border pulse: stroke alternates #e5e7eb↔#10b981 on a 6s loop with a short pause

`,
  {},
);

await printer.stdout(result, { reasoning: false, wrapInTags: false });
