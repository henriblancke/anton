import { isBoardGrouping, type BoardGrouping } from "@/components/board/board-utils";

/**
 * Where the board's grouping preference lives on the wire. A COOKIE rather than localStorage
 * (anton-wds3): the choice decides the board's whole layout — stage columns with the Up Next lane,
 * or product swimlanes without it — so the server has to know it at first paint. Storage the server
 * cannot read forces every load to paint the `stage` default and then throw it away on mount, which
 * an operator on Epic grouping sees as the lane flashing in and vanishing on every single load.
 *
 * Still the viewer's preference, not board state: no round trip and no column in anton.db, exactly
 * as before — only in the one client store the request already carries.
 */
const COOKIE_PREFIX = "anton.board-grouping.";

/** A year: the preference is a habit, not a session. */
export const BOARD_GROUPING_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Per project, because the grouping that suits one board is not the one that suits the next. */
export function boardGroupingCookieName(slug: string): string {
  return COOKIE_PREFIX + encodeURIComponent(slug);
}

/** An unset, unreadable, or unrecognised cookie reads as the `stage` default. */
export function parseBoardGrouping(value: string | undefined): BoardGrouping {
  return isBoardGrouping(value) ? value : "stage";
}
