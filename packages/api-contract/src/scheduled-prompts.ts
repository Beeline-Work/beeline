/** Dedicated hidden scheduler identity (sha256('beeline-scheduler')) that authors
 *  scheduled posts when the schedule has no human creator — never the target agent
 *  itself, whose own-authored rows the daemon inbox filter drops. */
export const SCHEDULE_SCHEDULER_ID =
  '7218ea1ccc85c23065e08efd8fc7dd50f6ffd7bcc91b0a3d5a037853f2de1721';
export const SCHEDULE_SCHEDULER_NAME = 'Beeline Scheduler';
/** The verb of the scheduler's system line (`Beeline Scheduler ran a schedule for
 *  Candy · <message>`). The thin daemon turn loop treats only a system line whose
 *  structured event carries this verb as an addressable scheduled prompt; plain
 *  system lines never trigger turns. */
export const SCHEDULE_RAN_VERB = 'ran a schedule for';
