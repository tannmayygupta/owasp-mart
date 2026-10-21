// Paging for the list screens (deferred work of the shop review: list paging). A page is PAGE_SIZE rows; the service is asked for one more row than a page holds, which is
// how the screen knows there is a next page without a COUNT. `?page=N` is a whole number from 1; anything else is page 1.
export const PAGE_SIZE = 50;
const MAX_PAGE = 10000;

/** { page, size, limit, offset } for a request: `limit` is size + 1 (the look-ahead row), `offset` the rows to skip. */
export function pageOf(query, size = PAGE_SIZE) {
  const n = Number.parseInt(query?.page, 10);
  const page = Number.isInteger(n) && n >= 1 && n <= MAX_PAGE ? n : 1;
  return { page, size, limit: size + 1, offset: (page - 1) * size };
}

/** The rows of one page and the pager the view draws. `path` is the list URL, `extra` more query text to keep (already encoded, starting with &). */
export function slicePage(rows, pg, path, extra = '') {
  return {
    rows: rows.slice(0, pg.size),
    pager: { page: pg.page, prev: pg.page > 1 ? `${path}?page=${pg.page - 1}${extra}` : null, next: rows.length > pg.size ? `${path}?page=${pg.page + 1}${extra}` : null },
  };
}