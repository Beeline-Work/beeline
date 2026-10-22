-- Executable baseline captured from PushDeliveryLoop at a04fb645e, before the
-- backlog fix. Parameter $1 is the leased message/device batch. Keep this frozen
-- so parity checks do not silently adopt changes to the new delivery policy.
-- Only leased message/device IDs enter eligibility and title projection.
      WITH queued_messages AS MATERIALIZED (
        SELECT m.*,context.turn_ids,context.burst_ids,d.token push_token,d.identity_id push_identity_id
        FROM jsonb_to_recordset($1::jsonb) queued(message_id text,device_token text)
        JOIN LATERAL (SELECT * FROM messages WHERE id=queued.message_id OFFSET 0) m ON true
        JOIN push_message_context context ON context.message_id=m.id
        JOIN push_delivery_floors floor ON floor.id='message-delivery'
        JOIN effective_memberships member ON member.room_id=m.room_id AND member.removed_at IS NULL
          AND member.identity_id<>m.author_id
        JOIN push_devices d ON d.token=queued.device_token AND d.identity_id=member.identity_id AND m.created_at>=d.registered_at
        WHERE m.created_at>=floor.started_at
          AND m.created_at>=now()-interval '1 hour'
          AND m.presentation IS DISTINCT FROM 'activity'
          AND m.card_type IS DISTINCT FROM 'agent-yolo'
          -- An automatic access receipt asks nothing of anyone.
          AND m.card_type IS DISTINCT FROM 'grant-auto'
          AND m.card_type IS DISTINCT FROM 'turn-failed'
          AND (m.card_type IS DISTINCT FROM 'relay' OR m.card->>'direction' IS DISTINCT FROM 'up')
          AND m.card_type IS DISTINCT FROM 'workspace-member-joined'
          -- An agent's order or report record is reference for corner readers.
          AND m.card_type IS DISTINCT FROM 'agent-command'
          AND m.deleted_at IS NULL
          AND btrim(m.text)<>''
          -- A closed corner is done: nothing posted there may push anyone.
          AND NOT EXISTS (SELECT 1 FROM rooms closed WHERE closed.id=m.room_id
            AND closed.parent_id IS NOT NULL AND closed.archived_at IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1 FROM push_delivery_claims claim
            WHERE claim.message_id=m.id AND claim.device_token=d.token
              AND NOT ((claim.status='retryable' AND claim.next_retry_at<=now()
                AND claim.attempts<3) OR (claim.status='claimed'
                AND claim.claimed_at<now()-interval '1 minute' AND claim.attempts<3))
          )
          AND NOT EXISTS (
    SELECT 1 FROM unnest(COALESCE((SELECT context.turn_ids FROM push_message_context context
      WHERE context.message_id=m.id),ARRAY[]::text[])) sibling_ids(id)
    CROSS JOIN LATERAL (SELECT * FROM messages WHERE id=sibling_ids.id OFFSET 0) sibling
    JOIN identities sibling_author ON sibling_author.id=sibling.author_id
      AND sibling_author.kind='agent'
    JOIN push_delivery_claims sibling_claim ON sibling_claim.message_id=sibling.id
      AND sibling_claim.device_token=d.token
    WHERE m.request_id IS NOT NULL
      AND sibling.room_id=m.room_id AND sibling.author_id=m.author_id
      AND sibling.request_id=m.request_id AND sibling.id<>m.id
  )
          -- A completed turn's decision/tag metadata qualifies its final prose,
          -- rather than winning the turn's one push before that prose.
          AND NOT (m.presentation IN ('system','card') AND m.request_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM agent_turns t WHERE t.room_id=m.room_id
              AND t.request_id=m.request_id AND t.agent_id=m.author_id AND t.status='complete')
            AND EXISTS (SELECT 1 FROM unnest(context.turn_ids) final_ids(id)
    CROSS JOIN LATERAL (SELECT * FROM messages WHERE id=final_ids.id OFFSET 0) final WHERE final.room_id=m.room_id
              AND final.author_id=m.author_id AND final.request_id=m.request_id
              AND final.presentation='message' AND final.deleted_at IS NULL))
          -- Durable chat from agents waits for completion and selects final prose.
          AND (m.presentation<>'message' OR m.request_id IS NULL
            OR NOT EXISTS (SELECT 1 FROM identities a WHERE a.id=m.author_id AND a.kind='agent')
            OR (NOT EXISTS (SELECT 1 FROM agent_turns t WHERE t.room_id=m.room_id
                AND t.request_id=m.request_id AND t.agent_id=m.author_id AND t.status='working')
              AND NOT EXISTS (SELECT 1 FROM unnest(context.turn_ids) newer_ids(id)
    CROSS JOIN LATERAL (SELECT * FROM messages WHERE id=newer_ids.id OFFSET 0) newer WHERE newer.room_id=m.room_id
                AND newer.author_id=m.author_id AND newer.request_id=m.request_id
                AND newer.presentation='message' AND newer.card_type IS NULL AND newer.deleted_at IS NULL
                AND (newer.created_at,newer.id)>(m.created_at,m.id))))
      ), candidates AS (
        SELECT m.id message_id,room.workspace_id::text workspace_id,
          COALESCE(room.parent_id,room.id)::text room_id,
          room.id::text channel_id,
          CASE WHEN room.parent_id IS NOT NULL THEN room.id::text END corner_id,
          'message' target,
          'message' notification_type,
          CASE
            -- System/card text already came from the one lifecycle grammar.
            WHEN m.presentation IN ('system','card') THEN btrim(m.text)
            ELSE concat_ws(': ',COALESCE(NULLIF(author.name,''),'Someone'),btrim(m.text))
          END text,
          m.push_token token,m.push_identity_id identity_id,m.created_at,
          -- Inline notification actions. A grant card answers from the
          -- notification only while it asks exactly one thing that is still
          -- pending, since three buttons cannot answer two asks. A reply is offered
          -- on messages from people and agents, never on a card, a system line,
          -- or the read-only @system DM.
          CASE
            WHEN m.card_type='grant-request' AND jsonb_typeof(m.card->'grants')='array'
              AND jsonb_array_length(m.card->'grants')=1
              AND EXISTS (
                SELECT 1 FROM agent_grants pending_grant
                WHERE pending_grant.id::text=m.card->'grants'->0->>'grantId'
                  AND pending_grant.status='pending'
              ) THEN 'grant'
            WHEN m.presentation='message' AND m.card_type IS NULL
              AND NOT COALESCE(room.direct_participants @> jsonb_build_array('972a35ec7a6e572c01c5b0a48cbdc82f6137dd7f35435cf9cc0ec305fdafa248'::text),false)
              THEN 'reply'
          END action,
          m.card->'grants'->0->>'grantId' grant_id,
          m.card->'grants'->0->>'kind' grant_kind,
          m.card->'grants'->0->>'target' grant_target,
          m.card->'agent'->>'name' grant_agent_name,
          COALESCE(NULLIF(author.name,''),'Someone') author_name,
          CASE WHEN attention.direct OR m.presentation<>'message' THEN
            CASE WHEN author.kind='human' AND m.presentation='message' THEN (
              SELECT burst.id FROM unnest(m.burst_ids) burst_ids(id)
    CROSS JOIN LATERAL (SELECT * FROM messages WHERE id=burst_ids.id OFFSET 0) burst
              WHERE burst.room_id=m.room_id AND burst.author_id=m.author_id
                AND burst.presentation='message' AND burst.deleted_at IS NULL
                AND burst.created_at>=m.created_at-interval '20 seconds'
                AND (burst.created_at,burst.id)<=(m.created_at,m.id)
                AND (room.direct_participants IS NOT NULL OR ((COALESCE(burst.card_type,'') NOT IN ('corner-checks-blocked','corner-review-deadlock','corner-merge-yes')) AND (
    EXISTS (
      SELECT 1 FROM messages addressed
      WHERE addressed.id = burst.reply_to_message_id
        AND addressed.author_id=recipient.id
    )
    OR (
    burst.presentation NOT IN ('system','card')
    AND (
      (
        recipient.handle IS NOT NULL AND btrim(recipient.handle)<>''
        AND regexp_replace(regexp_replace(regexp_replace((CASE WHEN strpos(regexp_replace(burst.text,'\n\nFORWARDED FROM #[^\n]+$',''),'```')=0 THEN regexp_replace(burst.text,'\n\nFORWARDED FROM #[^\n]+$','')
    ELSE (SELECT string_agg(CASE WHEN left(chunk.parts[1],3)='```'
      THEN regexp_replace(chunk.parts[1],'[^\n]',' ','g') ELSE chunk.parts[1] END,'' ORDER BY chunk.ordinality)
      FROM regexp_matches(regexp_replace(burst.text,'\n\nFORWARDED FROM #[^\n]+$',''),'(```(?:(?!```).)*(?:```|$)|(?:[^`]|`(?!``))+)','g') WITH ORDINALITY AS chunk(parts,ordinality)) END),'`[^`\n]*`',' ','g'),
    '"[^"\n]*"|“[^”\n]*”',' ','g'), '^[ \t\r]*>[^\n]*','','gn') ~ ('(^|[^[:alnum:]_.-])@' ||
    regexp_replace(btrim(ltrim(recipient.handle,'@')),'([.-])','\&','g') ||
    '[.-]*($|[^[:alnum:]_.-])')
        AND NOT EXISTS (
          SELECT 1 FROM memberships rival_member
          JOIN identities rival ON rival.id=rival_member.identity_id
          WHERE rival_member.room_id=(SELECT COALESCE(parent_id,id) FROM rooms WHERE id=burst.room_id) AND rival_member.removed_at IS NULL
            AND rival_member.identity_id<>recipient.id
            AND btrim(ltrim(rival.handle,'@'))=btrim(ltrim(recipient.handle,'@'))
        )
      )
      OR (
        recipient.kind='human'
        AND recipient.id<>burst.author_id
        AND regexp_replace(regexp_replace(regexp_replace((CASE WHEN strpos(regexp_replace(burst.text,'\n\nFORWARDED FROM #[^\n]+$',''),'```')=0 THEN regexp_replace(burst.text,'\n\nFORWARDED FROM #[^\n]+$','')
    ELSE (SELECT string_agg(CASE WHEN left(chunk.parts[1],3)='```'
      THEN regexp_replace(chunk.parts[1],'[^\n]',' ','g') ELSE chunk.parts[1] END,'' ORDER BY chunk.ordinality)
      FROM regexp_matches(regexp_replace(burst.text,'\n\nFORWARDED FROM #[^\n]+$',''),'(```(?:(?!```).)*(?:```|$)|(?:[^`]|`(?!``))+)','g') WITH ORDINALITY AS chunk(parts,ordinality)) END),'`[^`\n]*`',' ','g'),
    '"[^"\n]*"|“[^”\n]*”',' ','g'), '^[ \t\r]*>[^\n]*','','gn') ~* '(^|[^[:alnum:]_.-])@channel[.-]*($|[^[:alnum:]_.-])'
        AND EXISTS (
          SELECT 1 FROM rooms channel_room
          JOIN memberships channel_member
            ON channel_member.room_id=COALESCE(channel_room.parent_id,channel_room.id)
           AND channel_member.identity_id=recipient.id
           AND channel_member.removed_at IS NULL
          WHERE channel_room.id=burst.room_id
        )
      )
    )
  )
    OR (burst.text ~ '^(needs-decision|blocked):' AND COALESCE(burst.card->>'reportToId',(
      SELECT source.author_id FROM agent_commands command JOIN messages source
        ON source.id=command.root_source_message_id AND source.room_id=burst.room_id
      WHERE command.id=burst.request_id AND command.agent_id=burst.author_id
    ))=recipient.id)
    -- A failed agent wake reaches the requester, or current Workspace managers.
    OR (burst.card_type='corner-agent-unreachable'
      AND COALESCE(burst.card->>'status','open')='open'
      AND COALESCE(burst.card->'recipientIds','[]'::jsonb) ? recipient.id)
    -- An open question card reaches one person: the one human it
    -- tags, or the requester when it tags nobody. A question that
    -- tags several people, and every poll, reaches nobody.
    OR (
      burst.card_type='choice' AND burst.card->>'mode'='question'
      AND COALESCE(burst.card->>'status','open')='open'
      AND CASE jsonb_array_length(COALESCE(burst.card->'mentionIds','[]'::jsonb))
        WHEN 0 THEN burst.card->'requester'->>'pubkey'=recipient.id
        WHEN 1 THEN burst.card->'mentionIds'->>0=recipient.id
        ELSE false
      END
    )
    -- A corner's commissioner hears its final state whether or not
    -- an agent tags them: it landed (the parent Room's merge card),
    -- its worker posted a deliverable (files on a reply in a corner
    -- with no pull request). Recovery work goes back to the agent.
    -- Each probe reaches corner_facts by its primary key. One OR across
    -- both keys hid corner_id from the index, and the push loop then
    -- scanned the whole table once per candidate message.
    OR (false AND (
      (burst.card_type='daemon-fact' AND burst.card->>'type'='corner-complete' AND EXISTS (
        SELECT 1 FROM corner_facts finished
        WHERE finished.corner_id=CASE WHEN burst.card->>'cornerId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (burst.card->>'cornerId')::uuid END
          AND (finished.commissioned_by=recipient.id OR EXISTS (
    SELECT 1 FROM rooms opened WHERE opened.id=finished.corner_id AND opened.created_by=recipient.id))
      ))
      OR (burst.presentation='message' AND EXISTS (
        SELECT 1 FROM corner_facts finished
        WHERE finished.corner_id=burst.room_id
          AND (finished.commissioned_by=recipient.id OR EXISTS (
    SELECT 1 FROM rooms opened WHERE opened.id=finished.corner_id AND opened.created_by=recipient.id))
          AND burst.author_id=finished.owner_agent_id
          -- A corner without a pull request path: its parent Room has no repository.
          AND NOT EXISTS (
            SELECT 1 FROM rooms finished_corner
            JOIN rooms finished_parent ON finished_parent.id=finished_corner.parent_id
            WHERE finished_corner.id=finished.corner_id
              AND (finished_parent.repository_resolution='repository'
                OR finished_parent.repository_key IS NOT NULL))
          AND jsonb_typeof(burst.attachments)='array'
          AND jsonb_array_length(burst.attachments)>0
      ))
    ))
  )))
              ORDER BY burst.created_at,burst.id LIMIT 1)
            ELSE m.id END
          -- Keep human prose visible when a subsequent agent summary replaces its slot.
          ELSE CASE WHEN author.kind='human' THEN room.id::text ELSE 'agent:'||room.id::text END
          END collapse_id,
          COALESCE(attention.direct,false) direct_attention,
          -- A DM takes its title from dm_peer below, not from a Room name. A
          -- corner under a DM is titled from the DM's stored name, as in the app.
          CASE WHEN room.direct_participants IS NULL
            THEN COALESCE(parent.name,room.name) END room_name,
          CASE WHEN parent.id IS NOT NULL THEN room.name END corner_name,
          -- A DM is titled by its peer, who is this message's author.
          CASE WHEN room.direct_participants IS NOT NULL THEN jsonb_build_object(
            'name',COALESCE(NULLIF(author.name,''),'Someone'),
            'handle',author.handle,'avatar',author.avatar) END dm_peer
        FROM queued_messages m
        JOIN rooms room ON room.id=m.room_id
        LEFT JOIN rooms parent ON parent.id=room.parent_id
        LEFT JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
          AND workspace_member.room_id IS NULL AND workspace_member.identity_id=m.push_identity_id
          AND workspace_member.removed_at IS NULL
        JOIN identities author ON author.id=m.author_id
        JOIN identities recipient ON recipient.id=m.push_identity_id AND recipient.kind='human'
        CROSS JOIN LATERAL (SELECT (
          (room.direct_participants IS NOT NULL AND (m.presentation='message' OR m.card_type IS NULL OR m.card_type='grant-request'))
          OR (m.card_type='machine-offline' AND m.card->>'status'='open'
            AND m.card->>'ownerId'=recipient.id)
          OR ((COALESCE(m.card_type,'') NOT IN ('corner-checks-blocked','corner-review-deadlock','corner-merge-yes')) AND (
    EXISTS (
      SELECT 1 FROM messages addressed
      WHERE addressed.id = m.reply_to_message_id
        AND addressed.author_id=recipient.id
    )
    OR (
    m.presentation NOT IN ('system','card')
    AND (
      (
        recipient.handle IS NOT NULL AND btrim(recipient.handle)<>''
        AND regexp_replace(regexp_replace(regexp_replace((CASE WHEN strpos(regexp_replace(m.text,'\n\nFORWARDED FROM #[^\n]+$',''),'```')=0 THEN regexp_replace(m.text,'\n\nFORWARDED FROM #[^\n]+$','')
    ELSE (SELECT string_agg(CASE WHEN left(chunk.parts[1],3)='```'
      THEN regexp_replace(chunk.parts[1],'[^\n]',' ','g') ELSE chunk.parts[1] END,'' ORDER BY chunk.ordinality)
      FROM regexp_matches(regexp_replace(m.text,'\n\nFORWARDED FROM #[^\n]+$',''),'(```(?:(?!```).)*(?:```|$)|(?:[^`]|`(?!``))+)','g') WITH ORDINALITY AS chunk(parts,ordinality)) END),'`[^`\n]*`',' ','g'),
    '"[^"\n]*"|“[^”\n]*”',' ','g'), '^[ \t\r]*>[^\n]*','','gn') ~ ('(^|[^[:alnum:]_.-])@' ||
    regexp_replace(btrim(ltrim(recipient.handle,'@')),'([.-])','\&','g') ||
    '[.-]*($|[^[:alnum:]_.-])')
        AND NOT EXISTS (
          SELECT 1 FROM memberships rival_member
          JOIN identities rival ON rival.id=rival_member.identity_id
          WHERE rival_member.room_id=(SELECT COALESCE(parent_id,id) FROM rooms WHERE id=m.room_id) AND rival_member.removed_at IS NULL
            AND rival_member.identity_id<>recipient.id
            AND btrim(ltrim(rival.handle,'@'))=btrim(ltrim(recipient.handle,'@'))
        )
      )
      OR (
        recipient.kind='human'
        AND recipient.id<>m.author_id
        AND regexp_replace(regexp_replace(regexp_replace((CASE WHEN strpos(regexp_replace(m.text,'\n\nFORWARDED FROM #[^\n]+$',''),'```')=0 THEN regexp_replace(m.text,'\n\nFORWARDED FROM #[^\n]+$','')
    ELSE (SELECT string_agg(CASE WHEN left(chunk.parts[1],3)='```'
      THEN regexp_replace(chunk.parts[1],'[^\n]',' ','g') ELSE chunk.parts[1] END,'' ORDER BY chunk.ordinality)
      FROM regexp_matches(regexp_replace(m.text,'\n\nFORWARDED FROM #[^\n]+$',''),'(```(?:(?!```).)*(?:```|$)|(?:[^`]|`(?!``))+)','g') WITH ORDINALITY AS chunk(parts,ordinality)) END),'`[^`\n]*`',' ','g'),
    '"[^"\n]*"|“[^”\n]*”',' ','g'), '^[ \t\r]*>[^\n]*','','gn') ~* '(^|[^[:alnum:]_.-])@channel[.-]*($|[^[:alnum:]_.-])'
        AND EXISTS (
          SELECT 1 FROM rooms channel_room
          JOIN memberships channel_member
            ON channel_member.room_id=COALESCE(channel_room.parent_id,channel_room.id)
           AND channel_member.identity_id=recipient.id
           AND channel_member.removed_at IS NULL
          WHERE channel_room.id=m.room_id
        )
      )
    )
  )
    OR (m.text ~ '^(needs-decision|blocked):' AND COALESCE(m.card->>'reportToId',(
      SELECT source.author_id FROM agent_commands command JOIN messages source
        ON source.id=command.root_source_message_id AND source.room_id=m.room_id
      WHERE command.id=m.request_id AND command.agent_id=m.author_id
    ))=recipient.id)
    -- A failed agent wake reaches the requester, or current Workspace managers.
    OR (m.card_type='corner-agent-unreachable'
      AND COALESCE(m.card->>'status','open')='open'
      AND COALESCE(m.card->'recipientIds','[]'::jsonb) ? recipient.id)
    -- An open question card reaches one person: the one human it
    -- tags, or the requester when it tags nobody. A question that
    -- tags several people, and every poll, reaches nobody.
    OR (
      m.card_type='choice' AND m.card->>'mode'='question'
      AND COALESCE(m.card->>'status','open')='open'
      AND CASE jsonb_array_length(COALESCE(m.card->'mentionIds','[]'::jsonb))
        WHEN 0 THEN m.card->'requester'->>'pubkey'=recipient.id
        WHEN 1 THEN m.card->'mentionIds'->>0=recipient.id
        ELSE false
      END
    )
    -- A corner's commissioner hears its final state whether or not
    -- an agent tags them: it landed (the parent Room's merge card),
    -- its worker posted a deliverable (files on a reply in a corner
    -- with no pull request). Recovery work goes back to the agent.
    -- Each probe reaches corner_facts by its primary key. One OR across
    -- both keys hid corner_id from the index, and the push loop then
    -- scanned the whole table once per candidate message.
    OR (false AND (
      (m.card_type='daemon-fact' AND m.card->>'type'='corner-complete' AND EXISTS (
        SELECT 1 FROM corner_facts finished
        WHERE finished.corner_id=CASE WHEN m.card->>'cornerId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (m.card->>'cornerId')::uuid END
          AND (finished.commissioned_by=recipient.id OR EXISTS (
    SELECT 1 FROM rooms opened WHERE opened.id=finished.corner_id AND opened.created_by=recipient.id))
      ))
      OR (m.presentation='message' AND EXISTS (
        SELECT 1 FROM corner_facts finished
        WHERE finished.corner_id=m.room_id
          AND (finished.commissioned_by=recipient.id OR EXISTS (
    SELECT 1 FROM rooms opened WHERE opened.id=finished.corner_id AND opened.created_by=recipient.id))
          AND m.author_id=finished.owner_agent_id
          -- A corner without a pull request path: its parent Room has no repository.
          AND NOT EXISTS (
            SELECT 1 FROM rooms finished_corner
            JOIN rooms finished_parent ON finished_parent.id=finished_corner.parent_id
            WHERE finished_corner.id=finished.corner_id
              AND (finished_parent.repository_resolution='repository'
                OR finished_parent.repository_key IS NOT NULL))
          AND jsonb_typeof(m.attachments)='array'
          AND jsonb_array_length(m.attachments)>0
      ))
    ))
  ))
          OR (author.kind='agent' AND m.presentation='message' AND m.request_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM unnest(m.turn_ids) part_ids(id)
    CROSS JOIN LATERAL (SELECT * FROM messages WHERE id=part_ids.id OFFSET 0) part WHERE part.room_id=m.room_id
              AND part.author_id=m.author_id AND part.request_id=m.request_id
              AND part.deleted_at IS NULL
              AND ((COALESCE(part.card_type,'') NOT IN ('corner-checks-blocked','corner-review-deadlock','corner-merge-yes')) AND (
    EXISTS (
      SELECT 1 FROM messages addressed
      WHERE addressed.id = part.reply_to_message_id
        AND addressed.author_id=recipient.id
    )
    OR (
    part.presentation NOT IN ('system','card')
    AND (
      (
        recipient.handle IS NOT NULL AND btrim(recipient.handle)<>''
        AND regexp_replace(regexp_replace(regexp_replace((CASE WHEN strpos(regexp_replace(part.text,'\n\nFORWARDED FROM #[^\n]+$',''),'```')=0 THEN regexp_replace(part.text,'\n\nFORWARDED FROM #[^\n]+$','')
    ELSE (SELECT string_agg(CASE WHEN left(chunk.parts[1],3)='```'
      THEN regexp_replace(chunk.parts[1],'[^\n]',' ','g') ELSE chunk.parts[1] END,'' ORDER BY chunk.ordinality)
      FROM regexp_matches(regexp_replace(part.text,'\n\nFORWARDED FROM #[^\n]+$',''),'(```(?:(?!```).)*(?:```|$)|(?:[^`]|`(?!``))+)','g') WITH ORDINALITY AS chunk(parts,ordinality)) END),'`[^`\n]*`',' ','g'),
    '"[^"\n]*"|“[^”\n]*”',' ','g'), '^[ \t\r]*>[^\n]*','','gn') ~ ('(^|[^[:alnum:]_.-])@' ||
    regexp_replace(btrim(ltrim(recipient.handle,'@')),'([.-])','\&','g') ||
    '[.-]*($|[^[:alnum:]_.-])')
        AND NOT EXISTS (
          SELECT 1 FROM memberships rival_member
          JOIN identities rival ON rival.id=rival_member.identity_id
          WHERE rival_member.room_id=(SELECT COALESCE(parent_id,id) FROM rooms WHERE id=part.room_id) AND rival_member.removed_at IS NULL
            AND rival_member.identity_id<>recipient.id
            AND btrim(ltrim(rival.handle,'@'))=btrim(ltrim(recipient.handle,'@'))
        )
      )
      OR (
        recipient.kind='human'
        AND recipient.id<>part.author_id
        AND regexp_replace(regexp_replace(regexp_replace((CASE WHEN strpos(regexp_replace(part.text,'\n\nFORWARDED FROM #[^\n]+$',''),'```')=0 THEN regexp_replace(part.text,'\n\nFORWARDED FROM #[^\n]+$','')
    ELSE (SELECT string_agg(CASE WHEN left(chunk.parts[1],3)='```'
      THEN regexp_replace(chunk.parts[1],'[^\n]',' ','g') ELSE chunk.parts[1] END,'' ORDER BY chunk.ordinality)
      FROM regexp_matches(regexp_replace(part.text,'\n\nFORWARDED FROM #[^\n]+$',''),'(```(?:(?!```).)*(?:```|$)|(?:[^`]|`(?!``))+)','g') WITH ORDINALITY AS chunk(parts,ordinality)) END),'`[^`\n]*`',' ','g'),
    '"[^"\n]*"|“[^”\n]*”',' ','g'), '^[ \t\r]*>[^\n]*','','gn') ~* '(^|[^[:alnum:]_.-])@channel[.-]*($|[^[:alnum:]_.-])'
        AND EXISTS (
          SELECT 1 FROM rooms channel_room
          JOIN memberships channel_member
            ON channel_member.room_id=COALESCE(channel_room.parent_id,channel_room.id)
           AND channel_member.identity_id=recipient.id
           AND channel_member.removed_at IS NULL
          WHERE channel_room.id=part.room_id
        )
      )
    )
  )
    OR (part.text ~ '^(needs-decision|blocked):' AND COALESCE(part.card->>'reportToId',(
      SELECT source.author_id FROM agent_commands command JOIN messages source
        ON source.id=command.root_source_message_id AND source.room_id=part.room_id
      WHERE command.id=part.request_id AND command.agent_id=part.author_id
    ))=recipient.id)
    -- A failed agent wake reaches the requester, or current Workspace managers.
    OR (part.card_type='corner-agent-unreachable'
      AND COALESCE(part.card->>'status','open')='open'
      AND COALESCE(part.card->'recipientIds','[]'::jsonb) ? recipient.id)
    -- An open question card reaches one person: the one human it
    -- tags, or the requester when it tags nobody. A question that
    -- tags several people, and every poll, reaches nobody.
    OR (
      part.card_type='choice' AND part.card->>'mode'='question'
      AND COALESCE(part.card->>'status','open')='open'
      AND CASE jsonb_array_length(COALESCE(part.card->'mentionIds','[]'::jsonb))
        WHEN 0 THEN part.card->'requester'->>'pubkey'=recipient.id
        WHEN 1 THEN part.card->'mentionIds'->>0=recipient.id
        ELSE false
      END
    )
    -- A corner's commissioner hears its final state whether or not
    -- an agent tags them: it landed (the parent Room's merge card),
    -- its worker posted a deliverable (files on a reply in a corner
    -- with no pull request). Recovery work goes back to the agent.
    -- Each probe reaches corner_facts by its primary key. One OR across
    -- both keys hid corner_id from the index, and the push loop then
    -- scanned the whole table once per candidate message.
    OR (false AND (
      (part.card_type='daemon-fact' AND part.card->>'type'='corner-complete' AND EXISTS (
        SELECT 1 FROM corner_facts finished
        WHERE finished.corner_id=CASE WHEN part.card->>'cornerId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (part.card->>'cornerId')::uuid END
          AND (finished.commissioned_by=recipient.id OR EXISTS (
    SELECT 1 FROM rooms opened WHERE opened.id=finished.corner_id AND opened.created_by=recipient.id))
      ))
      OR (part.presentation='message' AND EXISTS (
        SELECT 1 FROM corner_facts finished
        WHERE finished.corner_id=part.room_id
          AND (finished.commissioned_by=recipient.id OR EXISTS (
    SELECT 1 FROM rooms opened WHERE opened.id=finished.corner_id AND opened.created_by=recipient.id))
          AND part.author_id=finished.owner_agent_id
          -- A corner without a pull request path: its parent Room has no repository.
          AND NOT EXISTS (
            SELECT 1 FROM rooms finished_corner
            JOIN rooms finished_parent ON finished_parent.id=finished_corner.parent_id
            WHERE finished_corner.id=finished.corner_id
              AND (finished_parent.repository_resolution='repository'
                OR finished_parent.repository_key IS NOT NULL))
          AND jsonb_typeof(part.attachments)='array'
          AND jsonb_array_length(part.attachments)>0
      ))
    ))
  ))))
        ) direct) attention

        WHERE (
            room.direct_participants IS NULL
            OR m.card_type IS NULL
            OR NOT (room.direct_participants @> jsonb_build_array('972a35ec7a6e572c01c5b0a48cbdc82f6137dd7f35435cf9cc0ec305fdafa248'::text))
            OR workspace_member.identity_id IS NOT NULL
          )
          AND recipient.push_level IN ('attention','full')
          AND (
            attention.direct
            OR (recipient.push_level='full' AND m.presentation='message' AND m.card_type IS NULL)
          )
        UNION ALL
        SELECT notification.id message_id,notification.workspace_id::text workspace_id,
          notification.room_id::text room_id,
          notification.room_id::text channel_id,NULL::text corner_id,'message' target,
          'workspace-join' notification_type,
          btrim(notification.text) text,device.device_token token,push_device.identity_id,
          notification.created_at,
          NULL::text action,NULL::text grant_id,NULL::text grant_kind,NULL::text grant_target,
          NULL::text grant_agent_name,NULL::text author_name,NULL::text collapse_id,
          false direct_attention,NULL::text room_name,NULL::text corner_name,NULL::jsonb dm_peer
        FROM jsonb_to_recordset($1::jsonb) queued(message_id text,device_token text)
        JOIN workspace_join_notifications notification ON notification.id=queued.message_id
        JOIN workspace_join_notification_devices device ON device.notification_id=notification.id AND device.device_token=queued.device_token
        JOIN push_devices push_device ON push_device.token=device.device_token
        JOIN identities recipient ON recipient.id=push_device.identity_id
          AND recipient.kind='human' AND recipient.push_level IN ('full')
        JOIN memberships workspace_member ON workspace_member.workspace_id=notification.workspace_id
          AND workspace_member.room_id IS NULL AND workspace_member.identity_id=push_device.identity_id
          AND workspace_member.removed_at IS NULL
        JOIN push_delivery_floors floor ON floor.id='message-delivery'
        WHERE notification.created_at>=push_device.registered_at
          AND notification.created_at>=floor.started_at
          AND notification.created_at>=now()-interval '1 hour'
          AND btrim(notification.text)<>''
      ), unclaimed AS (
        SELECT DISTINCT ON (candidate.message_id,candidate.token)
          candidate.message_id,candidate.workspace_id,candidate.room_id,candidate.channel_id,
          candidate.corner_id,candidate.target,
          candidate.notification_type,candidate.text,candidate.token,candidate.identity_id,
          candidate.created_at,device.platform,
          candidate.action,candidate.grant_id,candidate.grant_kind,candidate.grant_target,
          candidate.grant_agent_name,candidate.author_name,candidate.collapse_id,
          candidate.direct_attention,candidate.room_name,candidate.corner_name,candidate.dm_peer
        FROM candidates candidate
        JOIN push_devices device ON device.token=candidate.token
          AND device.platform IN ('android','ios','web')
        LEFT JOIN push_delivery_claims claim
          ON claim.message_id=candidate.message_id AND claim.device_token=candidate.token
        WHERE claim.message_id IS NULL OR (claim.status='retryable'
          AND claim.next_retry_at<=now() AND claim.attempts<3)
          OR (claim.status='claimed' AND claim.claimed_at<now()-interval '1 minute'
            AND claim.attempts<3)
        ORDER BY candidate.message_id,candidate.token
      )
      SELECT message_id,workspace_id,room_id,channel_id,corner_id,target,
        notification_type,text,token,identity_id,platform,
        action,grant_id,grant_kind,grant_target,grant_agent_name,author_name,collapse_id,
        direct_attention,room_name,corner_name,dm_peer
      FROM unclaimed ORDER BY created_at,message_id LIMIT 100
