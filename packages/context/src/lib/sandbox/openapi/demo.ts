import { openai } from '@ai-sdk/openai';
import { InMemoryFs } from 'just-bash';

import { input, printer } from '@deepagents/agent';

import { agent } from '../../agent.ts';
import { chat } from '../../chat.ts';
import { ContextEngine } from '../../engine.ts';
import { fragment } from '../../fragments.ts';
import { user } from '../../fragments/message/user.ts';
import { errorRecoveryGuardrail } from '../../guardrails/error-recovery.guardrail.ts';
import { skills } from '../../skills/fragments.ts';
import { InMemoryContextStore } from '../../store/memory.store.ts';
import { createBashTool } from '../bash-tool.ts';
import {
  createRoutingSandbox,
  createVirtualSandbox,
} from '../routing-sandbox.ts';
import { createOpenAPIExtension } from './extension.ts';
import { openapiSkill } from './skill/index.ts';

const baseUrl = 'http://localhost:3000';
const token = `eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6Ik9wQV9SUlE4bW0zY3RVeXhpaE5ISyJ9.eyJlbWFpbCI6Im1vaGFtbWFkLmphYmVyQGRlbGl2ZXJ5YXNzb2NpYXRlcy5jb20iLCJhdXRoMFVzZXIiOnsiYXBwX21ldGFkYXRhIjp7InBhc3N3b3JkQ2hhbmdlZCI6dHJ1ZSwidGVzdCI6dHJ1ZX0sImNyZWF0ZWRfYXQiOiIyMDI0LTEwLTAxVDE3OjIzOjAwLjU1NVoiLCJlbWFpbCI6Im1vaGFtbWFkLmphYmVyQGRlbGl2ZXJ5YXNzb2NpYXRlcy5jb20iLCJlbWFpbF92ZXJpZmllZCI6dHJ1ZSwibXVsdGlmYWN0b3IiOltdLCJuYW1lIjoibW9oYW1tYWQuamFiZXJAZGVsaXZlcnlhc3NvY2lhdGVzLmNvbSIsIm5pY2tuYW1lIjoibW9oYW1tYWQuamFiZXIiLCJwYXNzd29yZENoYW5nZWQiOnRydWUsInBpY3R1cmUiOiJodHRwczovL3MuZ3JhdmF0YXIuY29tL2F2YXRhci8yYWEzYTAzNTEzMjQ2NzQxNjJkMmZkMTM4OTkwNjg4Yz9zPTQ4MCZyPXBnJmQ9aHR0cHMlM0ElMkYlMkZjZG4uYXV0aDAuY29tJTJGYXZhdGFycyUyRm1vLnBuZyIsInRlc3QiOnRydWUsInVwZGF0ZWRfYXQiOiIyMDI2LTA0LTI3VDE3OjI0OjM3LjE5MFoiLCJ1c2VyX2lkIjoiYXV0aDB8NjZmYzJmZjQ2OGY2MjE5MzM5YTE4ZmM5IiwidXNlcl9tZXRhZGF0YSI6e319LCJpc3MiOiJodHRwczovL2RhYWkudXMuYXV0aDAuY29tLyIsInN1YiI6ImF1dGgwfDY2ZmMyZmY0NjhmNjIxOTMzOWExOGZjOSIsImF1ZCI6WyJodHRwczovL2ltcGFjdC5mbHkuZGV2L2FwaSIsImh0dHBzOi8vZGFhaS51cy5hdXRoMC5jb20vdXNlcmluZm8iXSwiaWF0IjoxNzc3NDYxMDAzLCJleHAiOjE3Nzc1NDc0MDMsInNjb3BlIjoib3BlbmlkIHByb2ZpbGUgZW1haWwgb2ZmbGluZV9hY2Nlc3MiLCJhenAiOiJFem5lNDZQZUhNNk9VMUdQSlE4T3djRTRISXpMUVBWQyJ9.DaPOMxlyBGlTfbEQm8-K1l7I-Q21p3xz911Fwnh1MfGqCBDbO8xUezp2YPwuE9FwYut9L1jdYRoZ3B61wqrpqp3tRTZGhyh0RKc5yCO7fHeg8rwHzG8m29FDA6_zBb6SNXkbIFBNxPxxzkUrJFTjxMIai4sjGyFSjpbV3ipcP5ZGfzb9IzDRqB57WLng83Epd_lIW1SBZc8eTm0oFHF9ewKhEFkgJ7yT2onSvCMiCUh_Dlf-kzdgTLo398YV2SSJeCy_dhO5SiXp_iZ8fdLc9T7XnyHmv1_i0WF73ZE5Il7InH0L2ccRQmxFjbbno1nroGjg3jpOclpa4nvrC_10Sg`;

const sandbox = await createBashTool({
  destination: '/',
  skills: [openapiSkill()],
  sandbox: await createRoutingSandbox({
    backend: await createVirtualSandbox({ fs: new InMemoryFs() }),
    hostExtensions: [
      await createOpenAPIExtension({
        name: 'datahub',
        openapi: '/Users/ezzabuzaid/Desktop/mo/datahub/openapi.json',
        baseUrl,
        token: () => token,
      }),
    ],
  }),
});

const context = new ContextEngine({
  chatId: 'datahub-demo',
  userId: 'demo-user',
  store: new InMemoryContextStore(),
});

console.log(await sandbox.sandbox.executeCommand('datahub getProjects {}'));
// context.set(
//   fragment(
//     'datahub',
//     'datahub is an OpenAPI-backed bash extension. It does NOT support --help or -h. Follow the openapi-cli skill: always start with `datahub schema` to discover operations.',
//   ),
//   skills(sandbox),
// );

// const ai = agent({
//   name: 'Datahub Assistant',
//   model: openai('gpt-5.4-mini'),
//   context,
//   sandbox,
//   guardrails: [errorRecoveryGuardrail],
// });

// let text = 'list all datahub projects according to the skill.';

// while (true) {
//   const stream = await chat(ai, [user(text)]);
//   await printer.readableStream(stream);
//   text = await input();
// }
