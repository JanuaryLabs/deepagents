export function toPagination<T>(
  records: T,
  totalCount: number,
  page: number,
  pageSize: number,
) {
  return {
    records,
    totalCount,
    pageCount: Math.ceil(totalCount / pageSize),
    currentPage: page,
    pageSize,
    get hasMore() {
      return page < this.pageCount;
    },
  } as const;
}
