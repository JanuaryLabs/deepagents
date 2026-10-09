import { groq } from '@ai-sdk/groq';
import { type ToolExecutionOptions, tool } from 'ai';
import { writeFileSync } from 'node:fs';
import z from 'zod';

import { type Agent, agent, instructions } from '../../agent.ts';
import { printer } from '../../stream_utils.ts';
import { swarm } from '../../swarm.ts';
import { createSupervisor } from './../supervisor.ts';

type StepId = string;

interface PlanStep {
  id: StepId;
  description: string;
  createdAt: Date;
}

interface CompletedStep {
  id: StepId;
  description: string;
  result: string;
  completedAt: Date;
}

interface PendingWork {
  id: StepId;
  description: string;
  result: string;
  submittedAt: Date;
}

interface WorkFeedback {
  id: StepId;
  description: string;
  feedback: string;
  needsRevision: boolean;
  createdAt: Date;
}

interface PlanExecuteState {
  input: string;
  plan: PlanStep[];
  pastSteps: CompletedStep[];
  response?: string;
}

class PlanExecuteStateManager {
  private state: PlanExecuteState;
  private pendingWork: PendingWork[] = [];
  private workFeedback: WorkFeedback[] = [];

  constructor(initialInput: string) {
    this.state = {
      input: initialInput,
      plan: [],
      pastSteps: [],
      response: undefined,
    };
  }

  private generateStepId(): StepId {
    return `step_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  getCurrentState() {
    return { ...this.state };
  }

  updatePlan(planDescriptions: string[]): void {
    const newPlan: PlanStep[] = planDescriptions.map((description) => ({
      id: this.generateStepId(),
      description,
      createdAt: new Date(),
    }));

    this.state.plan = newPlan;
    console.log(
      '📋 State updated - New plan:',
      newPlan.map((p) => p.description),
    );
  }

  addCompletedStep(stepId: StepId, result: string): void {
    const planStep = this.state.plan.find((s) => s.id === stepId);
    if (!planStep) {
      throw new Error(`Step with ID ${stepId} not found in plan`);
    }

    const completedStep: CompletedStep = {
      id: stepId,
      description: planStep.description,
      result,
      completedAt: new Date(),
    };

    this.state.pastSteps.push(completedStep);
    // Remove completed step from plan
    this.state.plan = this.state.plan.filter((s) => s.id !== stepId);
    console.log(`✅ State updated - Completed step: ${planStep.description}`);
  }

  setFinalResponse(response: string): void {
    this.state.response = response;
    console.log('🎉 State updated - Final response set');
  }

  // New methods for work submission and evaluation
  submitWork(stepId: StepId, result: string): void {
    const planStep = this.state.plan.find((s) => s.id === stepId);
    if (!planStep) {
      throw new Error(`Step with ID ${stepId} not found in plan`);
    }

    // Check for duplicate submissions
    if (this.pendingWork.some((w) => w.id === stepId)) {
      throw new Error(`Work for step ${stepId} is already pending evaluation`);
    }

    const work: PendingWork = {
      id: stepId,
      description: planStep.description,
      result,
      submittedAt: new Date(),
    };

    this.pendingWork.push(work);
    console.log(`📤 Work submitted for evaluation: ${planStep.description}`);
  }

  getPendingWork(): PendingWork[] {
    return [...this.pendingWork];
  }

  approveWork(stepId: StepId): void {
    const workIndex = this.pendingWork.findIndex((w) => w.id === stepId);
    if (workIndex === -1) {
      throw new Error(`No pending work found for step ID ${stepId}`);
    }

    const work = this.pendingWork[workIndex];
    // Remove from pending and add to completed
    this.pendingWork.splice(workIndex, 1);
    this.addCompletedStep(stepId, work.result);
  }

  rejectWork(stepId: StepId, feedback: string): void {
    const workIndex = this.pendingWork.findIndex((w) => w.id === stepId);
    if (workIndex === -1) {
      throw new Error(`No pending work found for step ID ${stepId}`);
    }

    const work = this.pendingWork[workIndex];
    // Remove from pending and add feedback
    this.pendingWork.splice(workIndex, 1);

    const feedbackEntry: WorkFeedback = {
      id: stepId,
      description: work.description,
      feedback,
      needsRevision: true,
      createdAt: new Date(),
    };

    this.workFeedback.push(feedbackEntry);
    console.log(
      `❌ Work rejected: ${work.description} - Feedback: ${feedback}`,
    );
  }

  getWorkFeedback(): WorkFeedback[] {
    return [...this.workFeedback];
  }

  clearFeedback(stepId: StepId): void {
    const initialLength = this.workFeedback.length;
    this.workFeedback = this.workFeedback.filter((f) => f.id !== stepId);

    if (this.workFeedback.length === initialLength) {
      throw new Error(`No feedback found for step ID ${stepId}`);
    }
  }

  hasMoreSteps(): boolean {
    return this.state.plan.length > 0;
  }

  hasPendingWork(): boolean {
    return this.pendingWork.length > 0;
  }

  hasWorkFeedback(): boolean {
    return this.workFeedback.length > 0;
  }

  isComplete(): boolean {
    return !!this.state.response;
  }

  // Cleanup and recovery methods
  cleanupStaleWork(maxAgeMinutes = 30): void {
    const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
    const initialCount = this.pendingWork.length;

    this.pendingWork = this.pendingWork.filter(
      (work) => work.submittedAt > cutoff,
    );

    if (this.pendingWork.length < initialCount) {
      console.log(
        `🧹 Cleaned up ${initialCount - this.pendingWork.length} stale pending work items`,
      );
    }
  }

  findOrphanedFeedback(): WorkFeedback[] {
    // Find feedback for steps that are no longer in the plan
    const planStepIds = new Set(this.state.plan.map((s) => s.id));
    return this.workFeedback.filter(
      (feedback) => !planStepIds.has(feedback.id),
    );
  }

  cleanupOrphanedFeedback(): void {
    const orphaned = this.findOrphanedFeedback();
    if (orphaned.length > 0) {
      this.workFeedback = this.workFeedback.filter((feedback) =>
        this.state.plan.some((s) => s.id === feedback.id),
      );
      console.log(`🧹 Cleaned up ${orphaned.length} orphaned feedback items`);
    }
  }

  getStateStats() {
    return {
      planSteps: this.state.plan.length,
      completedSteps: this.state.pastSteps.length,
      pendingWork: this.pendingWork.length,
      activeFeedback: this.workFeedback.length,
      orphanedFeedback: this.findOrphanedFeedback().length,
      isComplete: this.isComplete(),
    };
  }
}

/**
 * What the state tools receive as context: the swarm's context variables,
 * which are the state manager. A tool context must be a plain object type,
 * which a class is not, so this is the manager's public surface.
 */
type PlanExecuteContext = Pick<
  PlanExecuteStateManager,
  keyof PlanExecuteStateManager
>;

// Create state management tools - now using context instead of closures
function createStateTools() {
  return {
    get_current_state: tool({
      description: 'Get the current state of the plan-and-execute workflow',
      inputSchema: z.object({}),
      execute: async (
        _,
        { context }: ToolExecutionOptions<PlanExecuteContext>,
      ) => {
        const state = context.getCurrentState();
        const stats = context.getStateStats();
        return {
          objective: state.input,
          currentPlan: state.plan.map((p) => ({
            id: p.id,
            description: p.description,
          })),
          completedSteps: state.pastSteps.map((s) => ({
            id: s.id,
            description: s.description,
            result: s.result,
          })),
          isComplete: context.isComplete(),
          hasMoreSteps: context.hasMoreSteps(),
          hasPendingWork: context.hasPendingWork(),
          hasWorkFeedback: context.hasWorkFeedback(),
          stats,
        };
      },
    }),

    update_plan: tool({
      description: 'Update the execution plan with new steps',
      inputSchema: z.object({
        plan: z.array(z.string()).describe('New plan steps to execute'),
      }),
      execute: async (
        { plan },
        { context }: ToolExecutionOptions<PlanExecuteContext>,
      ) => {
        try {
          context.cleanupOrphanedFeedback();
          context.updatePlan(plan);
          return `Plan updated with ${plan.length} steps`;
        } catch (error) {
          return `Error updating plan: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
      },
    }),

    add_completed_step: tool({
      description: 'Mark a step as completed and add its result (use step ID)',
      inputSchema: z.object({
        stepId: z.string().describe('The ID of the completed step'),
        result: z.string().describe('The result of the step execution'),
      }),
      execute: async (
        { stepId, result },
        { context }: ToolExecutionOptions<PlanExecuteContext>,
      ) => {
        try {
          context.addCompletedStep(stepId, result);
          return `Step "${stepId}" marked as completed`;
        } catch (error) {
          return `Error completing step: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
      },
    }),

    set_final_response: tool({
      description: 'Set the final response when the task is complete',
      inputSchema: z.object({
        response: z.string().describe('The final response to the user'),
      }),
      execute: async (
        { response },
        { context }: ToolExecutionOptions<PlanExecuteContext>,
      ) => {
        context.setFinalResponse(response);
        return 'Final response set - task is complete';
      },
    }),

    // New tools for Judge Agent workflow
    submit_work: tool({
      description: 'Submit completed work for evaluation by the judge',
      inputSchema: z.object({
        stepId: z.string().describe('The ID of the step that was worked on'),
        result: z.string().describe('The result of the work done'),
      }),
      execute: async (
        { stepId, result },
        { context }: ToolExecutionOptions<PlanExecuteContext>,
      ) => {
        try {
          context.submitWork(stepId, result);
          return `Work submitted for evaluation: step ${stepId}`;
        } catch (error) {
          return `Error submitting work: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
      },
    }),

    get_pending_work: tool({
      description: 'Get work that is pending evaluation',
      inputSchema: z.object({}),
      execute: async (
        _,
        { context }: ToolExecutionOptions<PlanExecuteContext>,
      ) => {
        const pending = context.getPendingWork();
        return {
          pendingCount: pending.length,
          pendingWork: pending.map((w) => ({
            id: w.id,
            description: w.description,
            result: w.result,
            submittedAt: w.submittedAt,
          })),
        };
      },
    }),

    approve_work: tool({
      description: 'Approve submitted work and mark it as completed',
      inputSchema: z.object({
        stepId: z.string().describe('The ID of the step to approve'),
      }),
      execute: async (
        { stepId },
        { context }: ToolExecutionOptions<PlanExecuteContext>,
      ) => {
        try {
          context.approveWork(stepId);
          return `Work approved and marked complete: step ${stepId}`;
        } catch (error) {
          return `Error approving work: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
      },
    }),

    reject_work: tool({
      description: 'Reject submitted work and provide feedback for improvement',
      inputSchema: z.object({
        stepId: z.string().describe('The ID of the step to reject'),
        feedback: z
          .string()
          .describe('Specific feedback on what needs improvement'),
      }),
      execute: async (
        { stepId, feedback },
        { context }: ToolExecutionOptions<PlanExecuteContext>,
      ) => {
        try {
          context.rejectWork(stepId, feedback);
          return `Work rejected with feedback: step ${stepId}`;
        } catch (error) {
          return `Error rejecting work: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
      },
    }),

    get_work_feedback: tool({
      description: 'Get feedback on previously rejected work',
      inputSchema: z.object({}),
      execute: async (
        _,
        { context }: ToolExecutionOptions<PlanExecuteContext>,
      ) => {
        const feedback = context.getWorkFeedback();
        return {
          feedbackCount: feedback.length,
          feedback: feedback.map((f) => ({
            id: f.id,
            description: f.description,
            feedback: f.feedback,
            needsRevision: f.needsRevision,
            createdAt: f.createdAt,
          })),
        };
      },
    }),

    clear_feedback: tool({
      description: 'Clear feedback for a step after addressing it',
      inputSchema: z.object({
        stepId: z.string().describe('The ID of the step to clear feedback for'),
      }),
      execute: async (
        { stepId },
        { context }: ToolExecutionOptions<PlanExecuteContext>,
      ) => {
        try {
          context.clearFeedback(stepId);
          return `Feedback cleared for step: ${stepId}`;
        } catch (error) {
          return `Error clearing feedback: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
      },
    }),

    get_current_task: tool({
      description: 'Get only the current task to execute (limited state view)',
      inputSchema: z.object({}),
      execute: async (
        _,
        { context }: ToolExecutionOptions<PlanExecuteContext>,
      ) => {
        const state = context.getCurrentState();
        const feedback = context.getWorkFeedback();

        // Check if there's feedback to address first
        if (feedback.length > 0) {
          const feedbackToAddress = feedback[0]; // Get first feedback
          return {
            type: 'feedback_task',
            stepId: feedbackToAddress.id,
            description: feedbackToAddress.description,
            feedback: feedbackToAddress.feedback,
            objective: state.input,
            message: `You need to address feedback for: "${feedbackToAddress.description}"`,
          };
        }

        // Otherwise get next task from plan
        if (state.plan.length > 0) {
          const currentTask = state.plan[0];
          return {
            type: 'new_task',
            stepId: currentTask.id,
            description: currentTask.description,
            objective: state.input,
            completedCount: state.pastSteps.length,
            message: `Next task to execute: "${currentTask.description}"`,
          };
        }

        return {
          type: 'no_task',
          message: 'No tasks available to execute',
        };
      },
    }),

    cleanup_state: tool({
      description: 'Clean up stale work and orphaned feedback',
      inputSchema: z.object({
        maxAgeMinutes: z
          .number()
          .optional()
          .describe('Maximum age for pending work in minutes (default: 30)'),
      }),
      execute: async (
        { maxAgeMinutes },
        { context }: ToolExecutionOptions<PlanExecuteContext>,
      ) => {
        context.cleanupStaleWork(maxAgeMinutes);
        context.cleanupOrphanedFeedback();
        const stats = context.getStateStats();
        return `State cleanup completed. Current stats: ${JSON.stringify(stats)}`;
      },
    }),
  };
}

// Initialize state manager
const stateTools = createStateTools();

const planner = agent<unknown, PlanExecuteStateManager>({
  name: 'planner',
  model: groq('moonshotai/kimi-k2-instruct-0905'),
  handoffDescription:
    'Creates comprehensive plans for quality-controlled execution',
  prompt: (context) => {
    const state = context?.getCurrentState();
    const isReplanning = state ? state.pastSteps.length > 0 : false;

    return instructions({
      purpose: [
        '📋 You are a strategic planning expert in a quality-controlled workflow.',
        '⚖️ IMPORTANT: All work will be evaluated by a judge before completion.',
        isReplanning
          ? '🔄 REPLANNING: Focus on remaining work based on judge-approved progress.'
          : '🎯 INITIAL PLANNING: Create comprehensive plan for judge-quality execution.',
        state ? `🎯 Working on: ${state.input}` : '',
        '🏆 Plan for excellence - each step will face quality evaluation.',
      ],
      routine: isReplanning
        ? [
            '1. Get current state to understand judge-approved progress',
            `📊 Progress analysis: ${state?.pastSteps.length || 0} steps passed judge evaluation`,
            '2. Review what quality standards the judge has established',
            '3. Analyze what high-quality work still needs completion',
            '4. Plan remaining steps that can meet judge approval:',
            '   - Build on judge-approved foundation',
            '   - Maintain established quality standards',
            '   - Address any gaps in objective coverage',
            '5. Update plan with quality-focused remaining steps',
            '6. Transfer to supervisor for quality-controlled execution',
          ]
        : [
            '1. Get current state to understand the objective thoroughly',
            '2. Analyze objective and design for judge-quality standards:',
            '   - Break into clear, evaluable steps',
            '   - Ensure each step has measurable outcomes',
            '   - Plan for comprehensive, accurate execution',
            '   - Consider judge evaluation criteria from start',
            '3. Create initial plan with quality focus:',
            '   - Each step should be substantial and complete',
            '   - Steps should build logically toward objective',
            '   - Plan for work that can pass quality review',
            '4. Update plan using update_plan tool',
            '5. Transfer to supervisor for quality-controlled workflow start',
          ],
    });
  },
  tools: {
    get_current_state: stateTools.get_current_state,
    update_plan: stateTools.update_plan,
  },
  handoffs: [() => supervisor],
});

const executor = agent<unknown, PlanExecuteStateManager>({
  name: 'executor',
  model: groq('moonshotai/kimi-k2-instruct-0905'),
  handoffDescription:
    'Executes individual tasks and submits work for quality review',
  prompt: (context) => {
    const state = context?.getCurrentState();
    const feedback = context?.getWorkFeedback() || [];
    const hasFeedback = feedback.length > 0;
    const completedCount = state?.pastSteps.length || 0;
    const remainingCount = state?.plan.length || 0;

    const isFirstTask = completedCount === 0;
    const isLastTask = remainingCount === 1;
    return instructions({
      purpose: [
        'You are an execution expert in a quality-controlled workflow.',
        '🎯 Your role: Execute tasks thoroughly and submit for judge evaluation.',
        '⚠️ CRITICAL: You CANNOT mark tasks complete - only the judge can approve work.',
        '🔄 All work must pass quality review before being marked complete.',
        hasFeedback
          ? '� PRIORITY: Address specific feedback from the judge before proceeding.'
          : '',
        isFirstTask
          ? '🚀 First task - establish high quality standards from the start.'
          : '',
        isLastTask
          ? '🎯 Final task - ensure comprehensive objective fulfillment.'
          : '',
      ],
      routine: hasFeedback
        ? [
            '1. FIRST: Get current task to see what feedback needs addressing',
            '2. Carefully review ALL feedback points provided by the judge',
            '3. Address each criticism and suggestion thoroughly:',
            '   - Fix any accuracy issues mentioned',
            '   - Add missing information or details',
            '   - Improve clarity and completeness',
            '   - Enhance quality to meet judge standards',
            '4. MANDATORY: Use submit_work tool with the step ID and improved content',
            '5. MANDATORY: Use clear_feedback tool with step ID after resubmission',
            '6. ONLY THEN: Transfer to supervisor for judge re-evaluation',
            '',
            '⚠️ CRITICAL: You MUST use submit_work tool - do not just describe the work!',
          ]
        : [
            '1. FIRST: Get current task to understand execution requirements',
            '2. Execute the task with high attention to quality:',
            isFirstTask
              ? '   - Provide comprehensive, accurate foundational information'
              : '   - Build meaningfully on previous completed work',
            isLastTask
              ? '   - Ensure complete satisfaction of original objective'
              : '   - Create solid groundwork for subsequent steps',
            '   - Use clear, well-structured presentation',
            '   - Include relevant details and context',
            '3. MANDATORY: Use submit_work tool with step ID and your completed work',
            '4. ONLY THEN: Transfer to supervisor for mandatory judge evaluation',
            '',
            '⚠️ CRITICAL: You MUST use submit_work tool with the actual content!',
            '⚠️ Do NOT just describe or output the work - submit it using the tool!',
          ],
    });
  },
  tools: {
    get_current_task: stateTools.get_current_task,
    submit_work: stateTools.submit_work,
    clear_feedback: stateTools.clear_feedback,
  },
  handoffs: [() => supervisor],
});

const judge = agent<unknown, PlanExecuteStateManager>({
  name: 'judge',
  model: groq('moonshotai/kimi-k2-instruct-0905'),
  handoffDescription:
    'Quality control expert who evaluates all submitted work before completion',
  prompt: (context) => {
    const state = context?.getCurrentState();
    const pending = context?.getPendingWork() || [];
    const completedCount = state?.pastSteps.length || 0;
    const remainingCount = state?.plan.length || 0;
    const totalProgress = completedCount + remainingCount;

    const isFirstWork = completedCount === 0;
    const isLastWork = remainingCount === 1;
    const workCount = pending.length;
    const progressPercentage =
      totalProgress > 0
        ? Math.round((completedCount / totalProgress) * 100)
        : 0;

    return instructions({
      purpose: [
        '⚖️ You are the QUALITY GATEKEEPER for this workflow.',
        '🎯 Your decisions directly impact workflow success and output quality.',
        '📊 Every piece of work must meet standards before being marked complete.',
        `Currently evaluating ${workCount} submission(s) at ${progressPercentage}% progress.`,
        isFirstWork
          ? '🔍 CRITICAL: First work sets quality baseline for entire workflow.'
          : '',
        isLastWork
          ? '� FINAL EVALUATION: This determines if objective is fully achieved.'
          : '',
      ],
      routine: [
        '1. Get current state to understand the full objective context',
        '2. Get pending work requiring evaluation',
        '3. For EACH piece of work, conduct thorough quality assessment:',
        '',
        '🔍 EVALUATION CRITERIA:',
        '   ✅ Accuracy: Is the information factually correct?',
        '   ✅ Completeness: Does it fully address the task requirement?',
        '   ✅ Relevance: Does it contribute meaningfully to the objective?',
        '   ✅ Quality: Is it well-structured and clear?',
        isFirstWork
          ? '   ✅ Foundation: Does it provide solid groundwork for next steps?'
          : '   ✅ Coherence: Does it build logically on previous work?',
        isLastWork
          ? '   ✅ Objective Achievement: Does it completely satisfy the original goal?'
          : '   ✅ Progress: Does it advance toward the objective?',
        '',
        '📝 DECISION PROCESS:',
        '   If work MEETS standards → approve_work (step moves to completed)',
        '   If work NEEDS improvement → reject_work with specific, actionable feedback',
        '',
        '💡 FEEDBACK GUIDELINES:',
        '   - Be specific about what needs fixing',
        '   - Explain WHY changes are needed',
        '   - Suggest HOW to improve',
        '   - Reference the original objective',
        isFirstWork
          ? '   - Set clear quality expectations for future work'
          : '',
        isLastWork ? '   - Ensure complete objective fulfillment' : '',
        '',
        '4. Use cleanup_state if you detect any workflow inconsistencies',
        '5. Transfer to supervisor when all pending work is evaluated',
        '',
        '⚠️ REMEMBER: Your approval/rejection directly affects workflow progress!',
      ],
    });
  },
  tools: {
    get_current_state: stateTools.get_current_state,
    get_pending_work: stateTools.get_pending_work,
    approve_work: stateTools.approve_work,
    reject_work: stateTools.reject_work,
    cleanup_state: stateTools.cleanup_state,
  },
  handoffs: [() => supervisor],
});

const replanner = agent<unknown, PlanExecuteStateManager>({
  name: 'replanner',
  model: groq('moonshotai/kimi-k2-instruct-0905'),
  handoffDescription:
    'Evaluates judge-approved progress and determines workflow completion or continuation',
  prompt: (context) => {
    const state = context?.getCurrentState();
    const completedCount = state?.pastSteps.length || 0;
    const remainingCount = state?.plan.length || 0;
    const totalSteps = completedCount + remainingCount;
    const progressRatio = totalSteps > 0 ? completedCount / totalSteps : 0;

    const isEarlyStage = progressRatio < 0.3;
    const isMidStage = progressRatio >= 0.3 && progressRatio < 0.7;
    const isLateStage = progressRatio >= 0.7;

    return instructions({
      purpose: [
        '🔄 You evaluate judge-approved progress and make strategic decisions.',
        '📊 Analyze quality-controlled completed work to determine next steps.',
        '🎯 Decide: Continue execution, revise plan, or complete objective.',
        `Progress: ${completedCount} ✅ judge-approved, ${remainingCount} 📋 remaining (${Math.round(progressRatio * 100)}%)`,
        isEarlyStage
          ? '📊 Early stage - validate approach with quality foundation'
          : '',
        isMidStage
          ? '📈 Mid stage - assess quality trajectory and approach effectiveness'
          : '',
        isLateStage
          ? '🏁 Late stage - prepare for comprehensive completion'
          : '',
      ],
      routine: [
        '1. Get current state to review ALL judge-approved completed work',
        '2. Analyze the quality and substance of approved work:',
        '   - Review what the judge found acceptable',
        '   - Assess cumulative progress toward objective',
        '   - Identify any gaps or missing elements',
        '',
        '🔍 QUALITY-BASED ASSESSMENT:',
        isEarlyStage
          ? '   - Verify strong foundation from judge-approved work'
          : '',
        isMidStage
          ? '   - Confirm approach is producing judge-quality results'
          : '',
        isLateStage
          ? '   - Ensure objective can be comprehensively satisfied'
          : '',
        '   - Check if completed work forms coherent progress',
        '   - Validate that quality standards are maintainable',
        '',
        '📋 STRATEGIC DECISION MATRIX:',
        '   ✅ If objective is FULLY met with high-quality work:',
        '      → Use set_final_response with comprehensive, well-structured answer',
        '      → Include insights from all judge-approved work',
        '',
        '   🔄 If MORE quality work is needed:',
        '      → Update plan with specific remaining steps',
        '      → Build on judge-approved foundation',
        '      → Ensure new steps maintain quality standards',
        '',
        '   🎯 If approach needs REFINEMENT:',
        '      → Revise strategy based on judge feedback patterns',
        '      → Update plan to address quality gaps',
        '      → Leverage successful approved work patterns',
        '',
        '3. Make decision and transfer back to supervisor',
        '',
        '⚖️ Remember: Only work that passed judge evaluation contributes to completion',
      ],
    });
  },
  tools: {
    get_current_state: stateTools.get_current_state,
    update_plan: stateTools.update_plan,
    set_final_response: stateTools.set_final_response,
  },
  handoffs: [() => supervisor],
});

const supervisor: Agent<unknown, PlanExecuteStateManager> =
  createSupervisor<PlanExecuteStateManager>({
    model: groq('moonshotai/kimi-k2-instruct-0905'),
    subagents: [planner, executor, judge, replanner],
    prompt: (context) => {
      const state = context?.getCurrentState();
      const hasPlan = state ? state.plan.length > 0 : false;
      const hasPendingWork = context?.hasPendingWork() || false;
      const hasFeedback = context?.hasWorkFeedback() || false;
      const isComplete = context?.isComplete() || false;
      const completedCount = state?.pastSteps.length || 0;
      const pendingCount = context?.getPendingWork()?.length || 0;
      const feedbackCount = context?.getWorkFeedback()?.length || 0;

      return instructions.supervisor({
        purpose: [
          '🎯 You orchestrate a quality-controlled plan-and-execute workflow.',
          '⚖️ CRITICAL: ALL work must pass through judge evaluation before completion.',
          '🔄 Manage the flow: Plan → Execute → Judge → (Approve/Feedback) → Replanning',
          `📊 Status: ${completedCount} ✅ completed, ${hasPlan ? state!.plan.length : 0} 📋 planned, ${pendingCount} ⏳ pending review, ${feedbackCount} 📝 feedback`,
          hasPlan
            ? isComplete
              ? '✅ Workflow complete - all work passed quality control'
              : '🔄 Quality-controlled workflow in progress'
            : '📋 Ready to create initial plan',
        ],
        routine: [
          '🎯 QUALITY-CONTROLLED WORKFLOW DECISION TREE:',
          '',
          '1️⃣ PLANNING PHASE:',
          !hasPlan
            ? '   → No plan exists → handoff to PLANNER (create initial plan)'
            : '',
          '',
          '2️⃣ EXECUTION PHASE:',
          hasPlan && !hasPendingWork && !hasFeedback
            ? '   → Plan exists, no pending work, no feedback → handoff to EXECUTOR'
            : '',
          '',
          '3️⃣ QUALITY CONTROL PHASE (MANDATORY):',
          hasPendingWork
            ? `   → ${pendingCount} pending work items need evaluation → handoff to JUDGE`
            : '',
          '',
          '4️⃣ FEEDBACK RESOLUTION PHASE:',
          hasFeedback && !hasPendingWork
            ? `   → ${feedbackCount} feedback items need addressing → handoff to EXECUTOR`
            : '',
          '',
          '5️⃣ PROGRESS ASSESSMENT PHASE:',
          '   → After judge approval cycles → handoff to REPLANNER for progress review',
          '',
          '6️⃣ COMPLETION:',
          isComplete
            ? '   ✅ Task complete (final response approved by judge) → END workflow'
            : '',
          '',
          '⚠️ WORKFLOW INTEGRITY RULES:',
          '   • NO work bypasses judge evaluation',
          '   • ALL feedback must be addressed before new work',
          '   • Judge decisions determine completion status',
          '   • Replanner only acts after judge-approved work',
          '   • Executor MUST use submit_work tool - not just describe work',
          '   • If executor transfers without submitting work → redirect to EXECUTOR',
          '',
          '🚨 TROUBLESHOOTING:',
          '   • If no pending work but work was described → redirect to EXECUTOR',
          '   • If executor bypassed submit_work → redirect to EXECUTOR',
          '   • If work output but not submitted → redirect to EXECUTOR',
          '',
          '� Monitor quality control effectiveness and workflow efficiency',
        ],
      });
    },
    tools: {
      get_current_state: stateTools.get_current_state,
      cleanup_state: stateTools.cleanup_state,
    },
  });
if (import.meta.main) {
  // const objective = await input(
  //   `Teach me how agent plan and execute patterns works.`,
  // );
  const objective =
    'Explain the origin of money in a simple educational format';
  const stateManager = new PlanExecuteStateManager(objective);
  const [result, stdout] = swarm(supervisor, objective, stateManager).tee();
  const [messages] = await Promise.all([
    Array.fromAsync(result),
    printer.readableStream(stdout),
  ]);
  writeFileSync(
    'supervisor_plan_and_execute_messages.json',
    JSON.stringify(messages, null, 2),
  );
  console.log('\n🎯 Final Answer:');
  const finalState = stateManager.getCurrentState();
  console.log('\n🗂️ Final State:');
  console.dir(finalState, { depth: null });
  // TODO: The planner agent should only handle the initial planning otherwise forward to the replanner.
}
