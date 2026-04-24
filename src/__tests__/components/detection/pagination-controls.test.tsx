import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  PaginationControls,
  type PaginationControlsLabels,
} from "@/components/detection/pagination-controls";

function labels(): PaginationControlsLabels {
  return {
    pageSizeLabel: "Rows per page",
    rangeIndicator: ({ start, end, total }) => `${start}-${end} of ${total}`,
    totalOnly: ({ total }) => `0 of ${total}`,
    pageOfTotal: ({ page, total }) => `Page ${page} of ${total}`,
    firstPage: "First page",
    previousPage: "Previous page",
    nextPage: "Next page",
    lastPage: "Last page",
    goToPageLabel: "Go to page",
    goToPagePlaceholder: "N",
    goToPageSubmit: "Go",
    walkingProgress: ({ current, target }) =>
      `Walking… ${current} of ${target}`,
  };
}

describe("PaginationControls rendering", () => {
  it("renders a locale-grouped range and page-of-total string", () => {
    const html = renderToStaticMarkup(
      <PaginationControls
        labels={labels()}
        locale="en-US"
        totalCount="1453"
        pageSize={50}
        page={1}
        hasPreviousPage={false}
        hasNextPage={true}
        onPageSizeChange={() => {}}
        onFirst={() => {}}
        onPrevious={() => {}}
        onNext={() => {}}
        onLast={() => {}}
        onGoToPage={() => {}}
      />,
    );

    expect(html).toContain("1-50 of 1,453");
    // Page-of-total reads the derived total pages (ceil(1453/50)=30).
    expect(html).toContain("Page 1 of 30");
  });

  it("disables the Prev / First buttons at the head of the connection", () => {
    const html = renderToStaticMarkup(
      <PaginationControls
        labels={labels()}
        locale="en-US"
        totalCount="500"
        pageSize={50}
        page={1}
        hasPreviousPage={false}
        hasNextPage={true}
        onPageSizeChange={() => {}}
        onFirst={() => {}}
        onPrevious={() => {}}
        onNext={() => {}}
        onLast={() => {}}
        onGoToPage={() => {}}
      />,
    );
    // A disabled button carries the `disabled` boolean attribute.
    expect(html).toMatch(/<button[^>]*aria-label="First page"[^>]*disabled/);
    expect(html).toMatch(/<button[^>]*aria-label="Previous page"[^>]*disabled/);
    // Next / Last remain enabled.
    expect(html).not.toMatch(/<button[^>]*aria-label="Next page"[^>]*disabled/);
    expect(html).not.toMatch(/<button[^>]*aria-label="Last page"[^>]*disabled/);
  });

  it("disables the Next / Last buttons at the tail of the connection", () => {
    const html = renderToStaticMarkup(
      <PaginationControls
        labels={labels()}
        locale="en-US"
        totalCount="500"
        pageSize={50}
        page={10}
        hasPreviousPage={true}
        hasNextPage={false}
        onPageSizeChange={() => {}}
        onFirst={() => {}}
        onPrevious={() => {}}
        onNext={() => {}}
        onLast={() => {}}
        onGoToPage={() => {}}
      />,
    );
    expect(html).toMatch(/<button[^>]*aria-label="Next page"[^>]*disabled/);
    expect(html).toMatch(/<button[^>]*aria-label="Last page"[^>]*disabled/);
    expect(html).not.toMatch(
      /<button[^>]*aria-label="First page"[^>]*disabled/,
    );
  });

  it("shows the zero-results total when totalCount is 0", () => {
    const html = renderToStaticMarkup(
      <PaginationControls
        labels={labels()}
        locale="en-US"
        totalCount="0"
        pageSize={50}
        page={1}
        hasPreviousPage={false}
        hasNextPage={false}
        onPageSizeChange={() => {}}
        onFirst={() => {}}
        onPrevious={() => {}}
        onNext={() => {}}
        onLast={() => {}}
        onGoToPage={() => {}}
      />,
    );
    expect(html).toContain("0 of 0");
  });

  it("formats large totals with the operator's locale grouping", () => {
    const html = renderToStaticMarkup(
      <PaginationControls
        labels={labels()}
        locale="en-US"
        totalCount="1234567"
        pageSize={100}
        page={1}
        hasPreviousPage={false}
        hasNextPage={true}
        onPageSizeChange={() => {}}
        onFirst={() => {}}
        onPrevious={() => {}}
        onNext={() => {}}
        onLast={() => {}}
        onGoToPage={() => {}}
      />,
    );
    expect(html).toContain("1-100 of 1,234,567");
  });

  it("renders the walking-progress hint when a walk is in flight", () => {
    const html = renderToStaticMarkup(
      <PaginationControls
        labels={labels()}
        locale="en-US"
        totalCount="1000"
        pageSize={50}
        page={1}
        hasPreviousPage={false}
        hasNextPage={true}
        walking={{ current: 3, target: 9 }}
        onPageSizeChange={() => {}}
        onFirst={() => {}}
        onPrevious={() => {}}
        onNext={() => {}}
        onLast={() => {}}
        onGoToPage={() => {}}
      />,
    );
    expect(html).toContain("Walking… 3 of 9");
  });

  it("exposes the page-size selector with a stable id", () => {
    const html = renderToStaticMarkup(
      <PaginationControls
        labels={labels()}
        locale="en-US"
        totalCount="500"
        pageSize={50}
        page={1}
        hasPreviousPage={false}
        hasNextPage={true}
        onPageSizeChange={() => {}}
        onFirst={() => {}}
        onPrevious={() => {}}
        onNext={() => {}}
        onLast={() => {}}
        onGoToPage={() => {}}
      />,
    );
    // The <label htmlFor="…"> must match the Radix Select trigger's id
    // so clicking the label focuses the selector.
    expect(html).toMatch(/<label[^>]*for="detection-page-size"/);
  });
});
