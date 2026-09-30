import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import {
  api,
  type ApiClient,
  type InsightsGraphResponse,
  type WindowQuery,
} from "../api/client.js";
import { insightsGraphQuery } from "../api/queries.js";

export type ReciprocityGraphProps = {
  client?: ApiClient;
  /** The window QueryControls just submitted. Null until the first sync succeeds. */
  window: WindowQuery | null;
};

type GraphNode = InsightsGraphResponse["nodes"][number];

export const FLAGGED_EDGE_COLOR = "#e4677c";
export const MUTUAL_EDGE_COLOR = "#5b6b96";
export const NODE_COLOR = "#2fc6d6";
export const GRAPH_BACKGROUND = "#0c0f19";
const GRAPH_HEIGHT = 420;

export function reviewVolume(node: Pick<GraphNode, "reviewsGiven" | "reviewsReceived">): number {
  return node.reviewsGiven + node.reviewsReceived;
}

/** Canvas area. At least 1 so a zero-volume node is still visible. */
export function nodeArea(node: Pick<GraphNode, "reviewsGiven" | "reviewsReceived">): number {
  return Math.max(1, reviewVolume(node));
}

export function hoverText(
  node: Pick<GraphNode, "label" | "reviewsGiven" | "reviewsReceived">,
): string {
  return `${node.label}: given ${node.reviewsGiven}, received ${node.reviewsReceived}`;
}

/** `nodeLabel` is inserted as HTML by react-force-graph. */
export function escapeTooltip(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function edgeColor(edge: { flagged?: boolean }): string {
  return edge.flagged === true ? FLAGGED_EDGE_COLOR : MUTUAL_EDGE_COLOR;
}

export function edgeWidth(edge: { flagged?: boolean }): number {
  return edge.flagged === true ? 3 : 1;
}

export function edgeDash(edge: { flagged?: boolean }): number[] | null {
  return edge.flagged === true ? [6, 3] : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "Request failed";
}

function isHoverNode(value: unknown): value is GraphNode {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.label === "string" &&
    typeof record.reviewsGiven === "number" &&
    typeof record.reviewsReceived === "number"
  );
}

function isEmpty(data: InsightsGraphResponse): boolean {
  return data.nodes.length === 0 && data.edges.length === 0;
}

export function ReciprocityGraph({ client = api, window }: ReciprocityGraphProps) {
  const graph = useQuery({
    ...insightsGraphQuery(client, window ?? { owner: "pending", repo: "pending" }),
    enabled: window !== null,
  });
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  const data = graph.data;

  useEffect(() => {
    const node = frame.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      if (node.clientWidth > 0) setWidth(node.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [data]);

  const graphData = useMemo(() => {
    if (!data) return { nodes: [], links: [] };
    return {
      nodes: data.nodes.map((node) => ({ ...node })),
      links: data.edges.map((edge) => ({ ...edge })),
    };
  }, [data]);

  if (window === null) {
    return <p role="status">Sync a repository to load the reciprocity graph.</p>;
  }
  if (graph.isError) {
    // role="alert" so a screen reader announces the failure; the "Error:" prefix is a non-color
    // cue so the message does not rely on the rose color alone (Decisions Q46).
    return (
      <p role="alert" data-status="error">
        Error: {errorMessage(graph.error)}
      </p>
    );
  }
  if (!data) {
    return (
      <p role="status" aria-busy="true">
        Loading reciprocity graph…
      </p>
    );
  }

  return (
    <section aria-label="Reciprocity">
      <h2>Reciprocity</h2>
      <p>Arrow points from reviewer to author. Node size is reviews given plus reviews received.</p>
      {isEmpty(data) ? (
        <p role="status">No reciprocity edges in this window.</p>
      ) : (
        <>
          <ul className="legend">
            <li>
              <span className="swatch" data-flagged="false" /> Mutual
            </li>
            <li>
              <span className="swatch" data-flagged="true" /> One-directional
            </li>
          </ul>
          <p role="status" data-hover={hovered ? "node" : "none"}>
            {hovered ? hoverText(hovered) : "Hover a person to see reviews given and received."}
          </p>
          <div className="graph-frame" ref={frame}>
            <ForceGraph2D
              graphData={graphData}
              width={width}
              height={GRAPH_HEIGHT}
              backgroundColor={GRAPH_BACKGROUND}
              nodeColor={NODE_COLOR}
              nodeRelSize={4}
              nodeVal={nodeArea}
              nodeLabel={(node) => (isHoverNode(node) ? escapeTooltip(hoverText(node)) : "")}
              linkColor={edgeColor}
              linkWidth={edgeWidth}
              linkLineDash={edgeDash}
              linkDirectionalArrowLength={4}
              linkDirectionalArrowRelPos={1}
              linkDirectionalArrowColor={edgeColor}
              onNodeHover={(node) => setHovered(node && isHoverNode(node) ? node : null)}
              cooldownTicks={120}
            />
          </div>
          <ul aria-label="Reciprocity edges">
            {data.edges.map((edge) => (
              <li
                key={`${edge.source}->${edge.target}`}
                data-flagged={edge.flagged ? "true" : "false"}
              >
                {edge.source} → {edge.target} · weight {edge.weight}
                {edge.flagged ? " · one-directional" : ""}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
