import participants from './participants.ts';
import { WhatsAppGroup } from './whatsapp.ts';

const message =
  'I am considering launching a local-first AI product for small businesses. What should I think about first?';

console.log('Zukhruf WhatsApp group\n');

await using group = await WhatsAppGroup.create({
  userId: process.env.USER ?? 'local',
  participants,
  onMessage: ({ author, content }) => {
    console.log(`${author}: ${content}\n`);
  },
});

await group.send(message);
