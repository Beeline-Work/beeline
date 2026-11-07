// Retire the unsolicited next-day wake and its private delivery state.
export const NEXT_DAY_CHECKIN_SCHEMA = `
DROP FUNCTION IF EXISTS note_checkin_first_message() CASCADE;
DROP FUNCTION IF EXISTS note_checkin_reply() CASCADE;
DO $$ BEGIN
 IF to_regclass('next_day_checkins') IS NOT NULL THEN
 PERFORM beeline_end_agent_turn(command.id,command.generation_id,'cancelled','checkin_retired',NULL)
 FROM agent_commands command WHERE command.state='pending' AND command.id IN (SELECT command_id FROM next_day_checkins);
 END IF;
END $$;
`;
