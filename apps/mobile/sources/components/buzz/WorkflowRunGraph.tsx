import React, { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { StyleSheet } from 'react-native-unistyles';
import type { WorkflowRunDetailView } from '@beeline/api-contract/phone';
import {
  GRAPH_NODE_Y,
  GRAPH_ROW,
  layoutWorkflowGraph,
  workflowStateLabel,
  type GraphRow,
} from '@/buzz/workflow-graph';
import { workflowRowMeta } from '@/buzz/workflow-run-copy';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';
import { HullLivePulse } from './MonoHull';

const NODE_RADIUS = 4;
const CURRENT_RADIUS = 4.5;
const HALO_SIZE = 18;
const STROKE = 1.5;

const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * The run page's whole state machine (mock v11): one circle per row in an SVG
 * gutter drawn from `layoutWorkflowGraph`, the state's name and one meta line
 * beside it. Brass is the path this run took; the current step breathes on the
 * shared live pulse. Nothing here is a control except the current step's
 * Open →, which goes to the corner the run is working in.
 */
export function WorkflowRunGraph({
  detail,
  onOpenRoom,
  testID = 'workflow-run-graph',
}: {
  detail: WorkflowRunDetailView;
  onOpenRoom: () => void;
  testID?: string;
}) {
  const layout = useMemo(
    () => layoutWorkflowGraph(detail.contract, detail.history),
    [detail.contract, detail.history],
  );
  const brass = styles.brass.color;
  const quiet = styles.quietLine.color;
  return (
    <View style={styles.graph} testID={testID}>
      <Svg
        {...DECORATIVE_GLYPH_PROPS}
        height={layout.height}
        style={[styles.gutter, { width: layout.width }]}
        testID={`${testID}-gutter`}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
      >
        {layout.edges.map((edge) => (
          <Path
            d={edge.path}
            fill="none"
            key={`${edge.kind}:${edge.from}>${edge.to}`}
            stroke={edge.traversed ? brass : quiet}
            strokeWidth={STROKE}
          />
        ))}
        {layout.chevrons.map((chevron, index) => (
          <Path
            d={chevron.path}
            fill="none"
            key={`chevron:${index}`}
            stroke={chevron.traversed ? brass : quiet}
            strokeWidth={STROKE}
          />
        ))}
        {layout.rows.map((row) => (
          <Circle
            cx={row.x}
            cy={row.y}
            fill={row.reach === 'current' || row.reach === 'traversed' ? brass : styles.ground.color}
            key={`node:${row.key}`}
            r={row.reach === 'current' ? CURRENT_RADIUS : NODE_RADIUS}
            stroke={
              row.reach === 'reachable'
                ? styles.hollow.color
                : row.reach === 'unreachable'
                  ? styles.ghost.color
                  : undefined
            }
            strokeWidth={row.reach === 'reachable' || row.reach === 'unreachable' ? 1 : undefined}
          />
        ))}
      </Svg>
      {layout.rows.map((row, index) =>
        row.reach === 'current' ? (
          <HullLivePulse
            key="halo"
            style={[
              styles.halo,
              {
                left: styles.gutter.left + row.x - HALO_SIZE / 2,
                top: index * GRAPH_ROW + GRAPH_NODE_Y - HALO_SIZE / 2,
              },
            ]}
          >
            <View style={styles.haloRing} testID={`${testID}-current-halo`} />
          </HullLivePulse>
        ) : null,
      )}
      {layout.rows.map((row) => (
        <GraphRowCopy
          detail={detail}
          gutterWidth={styles.gutter.left + layout.width}
          key={row.key}
          onOpenRoom={onOpenRoom}
          row={row}
          testID={`${testID}-row-${row.key}`}
        />
      ))}
    </View>
  );
}

function GraphRowCopy({
  row,
  detail,
  gutterWidth,
  onOpenRoom,
  testID,
}: {
  row: GraphRow;
  detail: WorkflowRunDetailView;
  gutterWidth: number;
  onOpenRoom: () => void;
  testID: string;
}) {
  const meta = workflowRowMeta(row, {
    contract: detail.contract,
    roleHolders: detail.roleHolders,
    run: detail.run,
  });
  const current = row.reach === 'current';
  const tone =
    row.reach === 'unreachable' ? styles.ghost : row.reach === 'reachable' ? styles.quiet : null;
  return (
    <View style={[styles.row, { paddingLeft: gutterWidth }]} testID={testID}>
      <View style={styles.copy}>
        <Text numberOfLines={1} style={[current ? styles.titleCurrent : styles.title, tone]}>
          {workflowStateLabel(row.state)}
        </Text>
        {meta ? (
          <Text
            numberOfLines={1}
            style={[styles.meta, current && styles.metaCurrent, row.reach === 'unreachable' && styles.ghost]}
            testID={`${testID}-meta`}
          >
            {meta}
          </Text>
        ) : null}
      </View>
      {current ? (
        <Pressable
          accessibilityLabel={`Open ${detail.run.roomName}`}
          accessibilityRole="link"
          onPress={onOpenRoom}
          style={({ pressed }) => [styles.open, pressed && styles.pressed]}
          testID={`${testID}-open`}
        >
          <Text style={styles.openText}>Open →</Text>
        </Pressable>
      ) : row.reach === 'traversed' && row.enteredAt !== undefined ? (
        <Text style={styles.time}>{TIME.format(new Date(row.enteredAt * 1_000))}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const { type, space } = theme.buzz;
  /** The first line of copy is centred on the circle. */
  const copyTop = GRAPH_NODE_Y - type.body.lineHeight / 2;
  return {
    graph: { position: 'relative', marginTop: space.sm },
    gutter: { position: 'absolute', left: space.xs, top: 0 },
    brass: { color: theme.buzz.accent },
    quietLine: { color: theme.buzz.borderStrong },
    ground: { color: theme.buzz.bgBase },
    hollow: { color: theme.buzz.textMuted },
    halo: { position: 'absolute', width: HALO_SIZE, height: HALO_SIZE },
    haloRing: {
      width: HALO_SIZE,
      height: HALO_SIZE,
      borderRadius: HALO_SIZE / 2,
      borderWidth: 1,
      borderColor: theme.buzz.accent,
      opacity: 0.5,
    },
    row: {
      height: GRAPH_ROW,
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingRight: space.md,
    },
    copy: { flex: 1, minWidth: 0, paddingTop: copyTop },
    title: { ...type.body, color: theme.buzz.textPrimary },
    titleCurrent: { ...type.bodyStrong, color: theme.buzz.textPrimary },
    meta: { ...type.meta, color: theme.buzz.ledgerQuiet },
    metaCurrent: { color: theme.buzz.accent },
    quiet: { color: theme.buzz.ledgerQuiet },
    ghost: { color: theme.buzz.ledgerGhost },
    time: {
      ...type.machine,
      color: theme.buzz.ledgerGhost,
      paddingTop: GRAPH_NODE_Y - type.machine.lineHeight / 2,
    },
    open: {
      minHeight: 44,
      minWidth: 44,
      justifyContent: 'center',
      alignItems: 'flex-end',
      marginTop: GRAPH_NODE_Y - 22,
    },
    pressed: { opacity: 0.6 },
    openText: { ...type.sectionHead, color: theme.buzz.accent },
  };
});
