import {
  GrprEvent,
  GrprSearchParams,
  GrprStatsParams,
  GrprSessionsParams,
} from "../../schema.js";

export type SearchResult = { events: GrprEvent[]; truncated: boolean };
export type StatsResult = { buckets: Array<{ key: string; count: number }> };
export type SessionsResult = {
  sessions: Array<{ session_id: string; last_ts: string; event_count: number; error_count: number }>;
};

export type ReadBackend = {
  search: (params: GrprSearchParams) => Promise<SearchResult>;
  stats: (params: GrprStatsParams) => Promise<StatsResult>;
  sessions: (params: GrprSessionsParams) => Promise<SessionsResult>;
};
