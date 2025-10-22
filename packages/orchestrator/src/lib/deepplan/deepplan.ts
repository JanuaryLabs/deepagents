import { groq } from '@ai-sdk/groq';
import z from 'zod';
import { pl } from 'zod/v4/locales';

import {
  agent,
  confirm,
  execute,
  generate,
  lmstudio,
  printer,
  toOutput,
  user,
} from '@deepagents/agent';
import { scratchpad_tool } from '@deepagents/toolbox';

const planner = agent({
  name: 'planner_agent',
  temperature: 1,
  prompt: `
	 		<SystemContext>
				You are part of an autonomous team called Background schedules that runs user requests in the background without additional user input.
			</SystemContext>

			<Identity>
				Your task is to create a plan that describes WHAT data and information needs to be gathered for the user's request.
				Think from the user's perspective - what do they want to know or see?
			</Identity>

			<UserContext>
				The user is an investor looking to identify all developer-specific companies that have received funding. They want a comprehensive list that can help them make informed investment decisions.
			</UserContext>

			<RequestContext>
				1. This request will be run every week.
				2. The system is already occupied with functionality to send results (e.g., via email, push notifications) once the plan is executed.
				3. The system already knows HOW to fetch data, store it, and deliver results.
			</RequestContext>

			<Instructions>
				CRITICAL: Your plan should describe WHAT information to gather, NOT HOW to gather it.

				Each step should describe ONE specific piece of information to find.
				DO NOT create a final "summary" step that lists all the data together.

				AVOID these types of steps:
				❌ "Build a query to extract data"
				❌ "Store data in a database"
				❌ "Create data extraction routine"
				❌ "Aggregate the collected information"
				❌ "List the companies along with their funding details" (this is a summary step)
				❌ "Store the company name, funding amount, and date"

				GOOD EXAMPLES (each step finds ONE type of data):
				✓ "Identify which companies are in the developer tools category"
				✓ "Find the funding amount each company received"
				✓ "Find the funding round type for each company (Series A, B, seed, etc.)"
				✓ "Find the date when each company received funding"
				✓ "Identify which investors funded each company"

				FORBIDDEN WORDS - Never use these in your steps:
				- store, save, persist
				- aggregate, compile, collect
				- along with, together with
				- generate, create, build
				- deliver, send

				Each step must:
				1. Focus on ONE specific data point
				2. Start with: "Identify...", "Find...", or "Determine..."
				3. NOT combine multiple data points in one step
			</Instructions>
		`,
  model: groq('openai/gpt-oss-20b'),
  output: z.object({
    plan: z
      .string()
      .describe(
        'A brief description of what information the user wants to see. Focus on the data itself, not the action of gathering it. Example: "Company names, funding amounts, funding dates, round types, and investor names for developer-specific companies that received funding."',
      ),
    steps: z.array(z.string()).min(4).max(5),
  }),
});

const replanner = agent({
  name: 'replanner_agent',
  model: groq('openai/gpt-oss-20b'),
  prompt: `
		<SystemContext>
			You are a replanner agent that refines and improves plans based on execution feedback.
		</SystemContext>

		<Identity>
			Your task is to take an existing plan and modify it to address any issues or gaps identified during execution.
		</Identity>

		<Instructions>
			1. Review the original plan and the feedback from execution.
			2. Identify any steps that failed or were insufficient.
			3. Modify existing steps or add new steps to ensure successful execution.
			4. Ensure the revised plan remains clear, actionable, and focused on gathering the required information.
		</Instructions>
	`,
  output: z.object({
    reasoning: z.string().describe('Why this replanning decision was made'),
    should_continue: z.boolean().describe('Should we continue executing?'),
    plan_changes: z
      .enum(['none', 'minor', 'major'])
      .describe('Extent of changes to the plan'),
    remaining_steps: z
      .array(
        z.object({
          description: z
            .string()
            .describe('What information to find or action to take'),
          expected_outcome: z
            .string()
            .describe('What should be accomplished by this step'),
        }),
      )
      .describe('Updated list of remaining steps'),
    new_insights: z
      .array(z.string())
      .default([])
      .describe('New insights learned that affected the plan'),
  }),
});

const messages = [
  user(
    // FUNDING & INVESTMENT EXAMPLES
    // '<UserRequest>I want to see all developer specific companies that got funded.</UserRequest>',
    // '<UserRequest>Show me all AI startups that raised Series A in the last month.</UserRequest>',
    // '<UserRequest>I want to track all fintech companies in Europe that received seed funding.</UserRequest>',

    // JOB HUNTING EXAMPLES
    // '<UserRequest>I am on a job hunt and only looking for companies that do 4 day work week exclusively. I work as graphic designer</UserRequest>',
    // '<UserRequest>Find remote senior software engineer positions at Y Combinator companies with salaries above $150k.</UserRequest>',
    // '<UserRequest>I want to see all data scientist roles at climate tech startups in California.</UserRequest>',

    // COMPETITOR ANALYSIS EXAMPLES
    // '<UserRequest>I have a startup in flower delivery space and want to see what my competitors did past week in terms of feature development.</UserRequest>',
    // '<UserRequest>Track all product launches by meal kit delivery companies in Q1 2024.</UserRequest>',
    // '<UserRequest>I need to know what marketing campaigns my competitors in the fitness app space are running.</UserRequest>',

    // REAL ESTATE EXAMPLES
    // '<UserRequest>Find all single-family homes in Austin under $500k with 3+ bedrooms that were listed this week.</UserRequest>',
    // '<UserRequest>Show me commercial properties in Miami that sold above asking price in the last 30 days.</UserRequest>',

    // E-COMMERCE & PRODUCT TRACKING
    // '<UserRequest>Track price changes on MacBook Pro models across major retailers.</UserRequest>',
    // '<UserRequest>Show me all new sneaker releases from Nike and Adidas this month.</UserRequest>',
    // '<UserRequest>I want to see what new features Amazon added to their seller dashboard.</UserRequest>',

    // NEWS & CONTENT MONITORING
    // '<UserRequest>Monitor all articles mentioning Tesla from major financial news outlets.</UserRequest>',
    // '<UserRequest>Track all academic papers published about quantum computing in 2024.</UserRequest>',
    // '<UserRequest>Find all podcast episodes featuring interviews with YC founders.</UserRequest>',

    // EVENT TRACKING
    // '<UserRequest>Show me all tech conferences happening in San Francisco in the next 3 months.</UserRequest>',
    // '<UserRequest>Find all webinars about digital marketing hosted by Fortune 500 companies.</UserRequest>',

    // SOCIAL MEDIA & INFLUENCER TRACKING
    // '<UserRequest>Track viral posts from fitness influencers with over 100k followers on Instagram.</UserRequest>',
    // '<UserRequest>Show me trending topics in the crypto community on Twitter.</UserRequest>',

    // LEGAL & REGULATORY
    // '<UserRequest>Monitor all new FDA approvals for pharmaceutical companies.</UserRequest>',
    // '<UserRequest>Track all patent filings by Apple related to AR/VR technology.</UserRequest>',

    // CURRENTLY ACTIVE EXAMPLE - Uncomment any example above to test
    // '<UserRequest>Show me all AI startups that raised Series A in the last month.</UserRequest>',
    '<UserRequest>Did apple released any new product in the past 3 months?</UserRequest>',
  ),
];

const executor = agent({
  name: 'executor_agent',
  model: groq('openai/gpt-oss-20b'),
  prompt: `
		<SystemContext>
			You are an executor agent that takes a plan created by a planner agent and executes it to gather the required data.
		</SystemContext>

		<Identity>
			Your task is to follow the steps outlined in the plan and gather the necessary information.
		</Identity>

		<Instructions>
			1. Review each step in the plan carefully.
			2. For each step, determine the best method to gather the required information.
			3. Execute the necessary actions to collect the data.
			4. Compile the gathered information into a structured format for delivery.

			CRITICAL: Focus on executing the steps as defined in the plan. Do not deviate from the outlined tasks.
		</Instructions>
	`,
  tools: {
    scratchpad: scratchpad_tool,
    browser_search: groq.tools.browserSearch({}),
  },
});
const { experimental_output: plan } = await generate(planner, messages, {});

for (const step of plan.steps ?? []) {
  console.log(`Executing step: ${step}`);
  const stepResult = await execute(
    executor,
    [...messages, user(`<PlanStep>${step}</PlanStep>`)],
    {},
  ).text;
  console.log(`Step result: ${stepResult}\n`);

  const replanning = await toOutput(execute(replanner, [], {}));
  console.dir(replanning, { depth: null });
  break;
}
