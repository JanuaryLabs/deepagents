import { writeFile } from 'node:fs/promises';

import { runPlanAndAct } from '../patterns/plan_and_act/plan_and_act.ts';

async function main() {
  // Example 1: Research task
  console.log('🔬 Example 1: Research Task');
  const researchQuery =
    'Research and summarize the current state of large language model reasoning capabilities, focusing on recent developments in 2024.';
  const researchResult = await runPlanAndAct(researchQuery, 8);

  console.log('\n===== RESEARCH PLAN =====');
  console.log('💭 Reasoning:', researchResult.plan.reasoning);
  researchResult.plan.plan.steps.forEach((s, i) => console.log(`${i + 1}. ${s}`));

  console.log('\n===== RESEARCH EXECUTION HISTORY =====');
  for (const h of researchResult.history) {
    console.log(`Step ${h.stepIndex + 1}: ${h.step}`);
    console.log(`  → Action: ${h.execution.action_taken}`);
    console.log(`  → Success: ${h.execution.success}`);
    console.log(`  → Decision: ${h.decision.decision.type}`);
  }

  console.log('\n===== RESEARCH ANSWER =====');
  console.log(researchResult.answer);

  // Example 2: Analysis task
  console.log('\n\n🔍 Example 2: Analysis Task');
  const analysisQuery =
    'Find information about the current TypeScript 5.x features and compare them with Python 3.12 features for developers choosing between the two.';
  const analysisResult = await runPlanAndAct(analysisQuery, 6);

  console.log('\n===== ANALYSIS PLAN =====');
  console.log('💭 Reasoning:', analysisResult.plan.reasoning);
  analysisResult.plan.plan.steps.forEach((s, i) => console.log(`${i + 1}. ${s}`));

  console.log('\n===== ANALYSIS EXECUTION HISTORY =====');
  for (const h of analysisResult.history) {
    console.log(`Step ${h.stepIndex + 1}: ${h.step}`);
    console.log(`  → Action: ${h.execution.action_taken}`);
    console.log(`  → Success: ${h.execution.success}`);
    console.log(`  → Decision: ${h.decision.decision.type}`);
  }

  console.log('\n===== ANALYSIS ANSWER =====');
  console.log(analysisResult.answer);

  // Save detailed results
  await writeFile(
    'plan_and_act_examples.json',
    JSON.stringify({ 
      research: researchResult, 
      analysis: analysisResult 
    }, null, 2),
  );

  console.log('\n✅ Examples completed! Results saved to plan_and_act_examples.json');
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('❌ Error running Plan-and-Act examples:', err);
    process.exit(1);
  });
}