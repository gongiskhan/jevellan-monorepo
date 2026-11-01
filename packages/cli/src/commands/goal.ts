// jv goal add|list|show|done|pause (brief sections 4 and 9): goals are directions the owner writes once; the planner's
// plan job (jv job run plan) reads the open ones of a project and proposes the next tasks. The work is jevellan-planner's
// (addGoal, listGoals, requireGoal, doneGoal, pauseGoal, goalView, formatGoalList); this module parses, prints and
// exits. --json prints what the MCP's jv_goal_* tools return and the UI's /api/goals routes answer: list {goals}, the
// others {goal}. Done is final; pause takes an open goal (a done one is refused, exit 2). Nothing deletes a goal.
//
//   jv goal add --project N --title T --text "..." [--priority 1..5]
//   jv goal list [--project N] [--state open|paused|done]
//   jv goal show|done|pause G

import type { CommandIo, ParsedArgs } from '../command.js';
import { flagInt, flagString, requireFlag, requirePositional } from '../command.js';
import { refused } from 'jevellan-core/errors';
import { openStore } from 'jevellan-core/store';
import { GOAL_STATES, type GoalState } from 'jevellan-core/types';
import { addGoal, doneGoal, formatGoalList, formatGoalView, goalView, listGoals, pauseGoal, requireGoal } from 'jevellan-planner';

export const GOAL_USAGE =
  'jv goal add --project N --title T --text "..." [--priority 1..5] | jv goal list [--project N] [--state open|paused|done] | jv goal show|done|pause G';

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const sub = args.positionals[0];
  if (sub !== 'add' && sub !== 'list' && sub !== 'show' && sub !== 'done' && sub !== 'pause') {
    throw refused(sub === undefined ? GOAL_USAGE : `unknown subcommand "goal ${sub}". ${GOAL_USAGE}`);
  }
  const store = openStore();
  try {
    switch (sub) {
      case 'add': {
        const project = requireFlag(args, 'project');
        const title = requireFlag(args, 'title');
        const text = flagString(args, 'text');
        if (text === undefined || text.trim() === '') throw refused('--text is required');
        const priority = flagInt(args, 'priority');
        const goal = goalView(store, addGoal(store, { project, title, text, ...(priority !== undefined ? { priority } : {}) }));
        io.result({ goal }, `${goal.id} added to ${goal.project} (priority ${goal.priority}): ${goal.title}`);
        return 0;
      }
      case 'list': {
        const project = flagString(args, 'project');
        const state = flagString(args, 'state');
        if (state !== undefined && !(GOAL_STATES as readonly string[]).includes(state)) throw refused(`--state is one of ${GOAL_STATES.join(', ')}`);
        const goals = listGoals(store, { ...(project ? { project } : {}), ...(state ? { states: [state as GoalState] } : {}) }).map((g) => goalView(store, g));
        io.result({ goals }, () => formatGoalList(goals));
        return 0;
      }
      case 'show': {
        const goal = goalView(store, requireGoal(store, requirePositional(args, 1, 'the goal id')));
        io.result({ goal }, () => formatGoalView(goal));
        return 0;
      }
      case 'done': {
        const goal = goalView(store, doneGoal(store, requirePositional(args, 1, 'the goal id')));
        io.result({ goal }, `${goal.id} done: ${goal.title}`);
        return 0;
      }
      case 'pause': {
        const goal = goalView(store, pauseGoal(store, requirePositional(args, 1, 'the goal id')));
        io.result({ goal }, `${goal.id} paused: ${goal.title}`);
        return 0;
      }
    }
  } finally {
    store.close();
  }
}
