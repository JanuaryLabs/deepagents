## Planning

This is one of the surprisingly complex modules to build. When you understand it, you think "oh, that makes sense," but getting there is tricky and sometimes does not make sense at all.

You hear about adding planning to an AI Agent, which means creating a plan for how the agent should execute and achieve the job at hand. A plan is typically a set of steps the agent needs to run to get there. This works until it does not. The first question at hand is: what if midway through, the agent started operating on a false premise because the steps no longer make sense given the agent's current state of execution?

So you think, okay, let's replan after each step, but this time the planner needs to be aware of the previous steps' results.

This approach works, but it consumes far more tokens than you might have initially anticipated.

---

This design is formally known as "Plan and Solve." It consists of four components:

- user message
- planner agent
- executor agent
- replanner agent

The planner creates a set of steps based on the user message.
The executor runs the steps one by one, but before moving to the next step, it checks the plan through the replanner agent. If any changes are needed, it outputs them and then repeats the loop until the replanner confirms that all is good and the plan is completed.
