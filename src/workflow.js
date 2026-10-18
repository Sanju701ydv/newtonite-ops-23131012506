// status -> { nextStatus: minimum role in the item's team }
const TRANSITIONS = {
  open: { in_progress: 'member' },
  in_progress: { awaiting_approval: 'member', open: 'member' },
  awaiting_approval: { resolved: 'lead', in_progress: 'lead' }, // approval gate: Leads only
  resolved: { closed: 'member', in_progress: 'member' },
  closed: {},
};
module.exports = { TRANSITIONS, TYPES: ['incident','customer_issue','payment','compliance','task'], PRIORITIES: ['low','medium','high','urgent'] };
