/**
 * Safe SQL Compiler — test suite.
 *
 * Run with: `npm test -- test/sql-compiler.test.ts`
 *
 * Coverage:
 *   - Identifier safety / quoting per dialect
 *   - Param placeholder formatting per dialect
 *   - Filter operators (eq, neq, gt, gte, lt, lte, in, between)
 *   - Date grain rendering per dialect
 *   - Multi-table join compilation
 *   - SQL injection attempts blocked at compile time
 *   - Param cap
 *   - Edge cases (empty selects, unknown columns, self-joins, etc.)
 */

import {
  compileKpiQuery,
  isSafeIdentifier,
  paramPlaceholder,
  quoteId,
  SafeSqlBuilder,
  SqlCompileError,
  TABLE_KEY,
  type ColumnResolver,
  type QueryPlanInput,
} from "../src/sql/compiler";
import type { DialectType } from "../src/types/types";

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

const ALL_DIALECTS: DialectType[] = [
  "mysql",
  "postgresql",
  "sqlserver",
  "sqlite",
  "snowflake",
  "bigquery",
  "databricks",
];

const orderCatalog: ColumnResolver = (ref) => {
  if (ref === `orders.${TABLE_KEY}`) return { table: "orders", column: "" };
  if (ref === "orders.region") return { table: "orders", column: "region" };
  if (ref === "orders.amount") return { table: "orders", column: "amount" };
  if (ref === "orders.orderDate") return { table: "orders", column: "order_date" };
  if (ref === "orders.customerId") return { table: "orders", column: "customer_id" };
  return null;
};

const orderCustomerCatalog: ColumnResolver = (ref) => {
  if (ref === `orders.${TABLE_KEY}`) return { table: "orders", column: "" };
  if (ref === `customers.${TABLE_KEY}`) return { table: "customers", column: "" };
  if (ref === "orders.region") return { table: "orders", column: "region" };
  if (ref === "orders.amount") return { table: "orders", column: "amount" };
  if (ref === "orders.customerId") return { table: "orders", column: "customer_id" };
  if (ref === "customers.id") return { table: "customers", column: "id" };
  if (ref === "customers.name") return { table: "customers", column: "name" };
  return null;
};

// ===========================================================================
// Identifier safety
// ===========================================================================

describe("isSafeIdentifier", () => {
  test.each([
    ["orders", true],
    ["customer_id", true],
    ["schema.orders", true],
    ["a", true],
    ["_underscore", true],
    ["orders_with_long_name_that_is_still_under_64_chars_aaaaa", true],
    ["123start", false],
    ["orders; DROP TABLE x", false],
    ["orders--", false],
    ["union", false],
    ["select", false],
    ["", false],
    ["a.b.c", false],  // only one dot allowed
    ["schema.orders; DROP", false],
  ])("isSafeIdentifier(%j) === %j", (input, expected) => {
    expect(isSafeIdentifier(input)).toBe(expected);
  });
});

// ===========================================================================
// quoteId — per dialect
// ===========================================================================

describe("quoteId — per dialect", () => {
  test.each([
    ["mysql", "`orders`"],
    ["postgresql", `"orders"`],
    ["sqlserver", "[orders]"],
    ["sqlite", "`orders`"],
    ["snowflake", `"orders"`],
    ["bigquery", "`orders`"],
    ["databricks", `"orders"`],
  ] as Array<[DialectType, string]>)("quoteId in %s", (dialect, expected) => {
    expect(quoteId("orders", dialect)).toBe(expected);
  });

  test("qualified identifiers quote each segment", () => {
    expect(quoteId("schema.orders", "mysql")).toBe("`schema`.`orders`");
    expect(quoteId("schema.orders", "postgresql")).toBe('"schema"."orders"');
    expect(quoteId("schema.orders", "sqlserver")).toBe("[schema].[orders]");
  });

  test("rejects SQL injection in identifiers", () => {
    expect(() => quoteId("orders; DROP TABLE x", "mysql")).toThrow(SqlCompileError);
    expect(() => quoteId("orders--", "mysql")).toThrow(SqlCompileError);
    expect(() => quoteId("orders/*comment*/", "mysql")).toThrow(SqlCompileError);
    expect(() => quoteId("`evil`", "mysql")).toThrow(SqlCompileError);
    expect(() => quoteId('"evil"', "postgresql")).toThrow(SqlCompileError);
    expect(() => quoteId("[evil]", "sqlserver")).toThrow(SqlCompileError);
  });

  test("rejects reserved keywords", () => {
    for (const kw of ["select", "union", "drop", "from", "where", "join", "group"]) {
      expect(() => quoteId(kw, "mysql")).toThrow(SqlCompileError);
    }
  });
});

// ===========================================================================
// paramPlaceholder — per dialect
// ===========================================================================

describe("paramPlaceholder", () => {
  test.each([
    [1, "mysql", "?"],
    [1, "postgresql", "$1"],
    [1, "sqlserver", "@p1"],
    [42, "mysql", "?"],
    [42, "postgresql", "$42"],
    [42, "sqlserver", "@p42"],
  ] as Array<[number, DialectType, string]>)("placeholder %d for %s", (idx, dialect, expected) => {
    expect(paramPlaceholder(idx, dialect)).toBe(expected);
  });

  test("rejects out-of-range indices", () => {
    expect(() => paramPlaceholder(0, "mysql")).toThrow(SqlCompileError);
    expect(() => paramPlaceholder(-1, "mysql")).toThrow(SqlCompileError);
    expect(() => paramPlaceholder(10_000, "mysql")).toThrow(SqlCompileError);
    expect(() => paramPlaceholder(1.5, "mysql")).toThrow(SqlCompileError);
  });
});

// ===========================================================================
// SafeSqlBuilder — basic mechanics
// ===========================================================================

describe("SafeSqlBuilder", () => {
  test("append + bind produces positional placeholders", () => {
    const b = new SafeSqlBuilder("postgresql");
    b.append("SELECT * FROM x WHERE id =");
    b.append(" " + b.bind(123));
    const seg = b.toSegment();
    expect(seg.sql).toBe("SELECT * FROM x WHERE id =\n $1");
    expect(seg.params).toEqual([123]);
  });

  test("quote uses dialect-appropriate quoting", () => {
    expect(new SafeSqlBuilder("mysql").quote("t")).toBe("`t`");
    expect(new SafeSqlBuilder("postgresql").quote("t")).toBe('"t"');
    expect(new SafeSqlBuilder("sqlserver").quote("t")).toBe("[t]");
  });

  test("rejects unsafe identifiers via quote()", () => {
    const b = new SafeSqlBuilder("mysql");
    expect(() => b.quote("t; DROP")).toThrow(SqlCompileError);
  });

  test("rejects undefined params", () => {
    const b = new SafeSqlBuilder("mysql");
    expect(() => b.bind(undefined as unknown as string)).toThrow(SqlCompileError);
  });

  test("rejects function/symbol params", () => {
    const b = new SafeSqlBuilder("mysql");
    expect(() => b.bind(() => 1)).toThrow(SqlCompileError);
    expect(() => b.bind(Symbol("x"))).toThrow(SqlCompileError);
  });

  test("respects param cap", () => {
    const b = new SafeSqlBuilder("mysql", { maxParams: 2 });
    b.bind("a"); b.bind("b");
    expect(() => b.bind("c")).toThrow(/PARAM_CAP_EXCEEDED/);
  });

  test("toSegment returns a copy of params", () => {
    const b = new SafeSqlBuilder("mysql");
    b.bind(1);
    const seg = b.toSegment();
    seg.params.push(999);
    expect(b.toSegment().params).toEqual([1]);
  });
});

// ===========================================================================
// compileKpiQuery — simple metric
// ===========================================================================

describe("compileKpiQuery — simple metric", () => {
  test("mysql: FROM only, no filters", () => {
    const r = compileKpiQuery(
      { datasets: ["orders"], metric: "SUM(amount)" },
      "mysql",
      orderCatalog,
      "SUM(amount)",
    );
    expect(r.dialect).toBe("mysql");
    expect(r.sql).toBe("FROM `orders`\nSELECT SUM(amount) AS `metric_value`");
    expect(r.params).toEqual([]);
  });

  test("postgresql: parameterised metric, no filters", () => {
    const r = compileKpiQuery(
      { datasets: ["orders"], metric: "COUNT(1)" },
      "postgresql",
      orderCatalog,
      "COUNT(1)",
    );
    expect(r.sql).toBe('FROM "orders"\nSELECT COUNT(1) AS "metric_value"');
  });

  test("sqlserver: SELECT TOP N is emitted when limit present", () => {
    const r = compileKpiQuery(
      { datasets: ["orders"], metric: "COUNT(1)", limit: 25 },
      "sqlserver",
      orderCatalog,
      "COUNT(1)",
    );
    expect(r.sql).toContain("SELECT TOP 25");
    expect(r.sql).not.toContain("LIMIT");
  });

  test("other dialects: LIMIT appended when limit present", () => {
    const dialects: DialectType[] = ["mysql", "postgresql", "sqlite", "snowflake", "bigquery", "databricks"];
    for (const d of dialects) {
      const r = compileKpiQuery(
        { datasets: ["orders"], metric: "COUNT(1)", limit: 5 },
        d,
        orderCatalog,
        "COUNT(1)",
      );
      expect(r.sql).toContain("LIMIT 5");
    }
  });

  test("non-integer limit is rejected", () => {
    expect(() => compileKpiQuery(
      { datasets: ["orders"], metric: "COUNT(1)", limit: 1.5 },
      "mysql",
      orderCatalog,
      "COUNT(1)",
    )).toThrow(/BAD_LIMIT/);
  });

  test("negative limit is rejected", () => {
    expect(() => compileKpiQuery(
      { datasets: ["orders"], metric: "COUNT(1)", limit: -5 },
      "mysql",
      orderCatalog,
      "COUNT(1)",
    )).toThrow(/BAD_LIMIT/);
  });
});

// ===========================================================================
// compileKpiQuery — filters
// ===========================================================================

describe("compileKpiQuery — filters", () => {
  test.each([
    ["eq", "=", "EMEA"],
    ["neq", "!=", "EMEA"],
    ["gt", ">", 100],
    ["gte", ">=", 100],
    ["lt", "<", 100],
    ["lte", "<=", 100],
  ] as const)("filter op %s", (op, sqlOp, value) => {
    const r = compileKpiQuery(
      {
        datasets: ["orders"],
        metric: "COUNT(1)",
        filters: [{ field: "orders.region", op, value: value as string | number }],
      },
      "postgresql",
      orderCatalog,
      "COUNT(1)",
    );
    expect(r.sql).toContain(`"orders"."region" ${sqlOp} $1`);
    expect(r.params).toEqual([value]);
  });

  test("IN filter renders N placeholders", () => {
    const r = compileKpiQuery(
      {
        datasets: ["orders"],
        metric: "COUNT(1)",
        filters: [{ field: "orders.region", op: "in", value: ["EMEA", "APAC", "AMER"] }],
      },
      "mysql",
      orderCatalog,
      "COUNT(1)",
    );
    expect(r.sql).toContain("`orders`.`region` IN (?, ?, ?)");
    expect(r.params).toEqual(["EMEA", "APAC", "AMER"]);
  });

  test("empty IN filter is rejected", () => {
    expect(() => compileKpiQuery(
      {
        datasets: ["orders"],
        metric: "COUNT(1)",
        filters: [{ field: "orders.region", op: "in", value: [] }],
      },
      "mysql",
      orderCatalog,
      "COUNT(1)",
    )).toThrow(/EMPTY_IN_FILTER/);
  });

  test("BETWEEN filter uses start/end", () => {
    const r = compileKpiQuery(
      {
        datasets: ["orders"],
        metric: "COUNT(1)",
        filters: [{ field: "orders.orderDate", op: "between", value: { start: "2025-01-01", end: "2025-12-31" } }],
      },
      "postgresql",
      orderCatalog,
      "COUNT(1)",
    );
    expect(r.sql).toContain('"orders"."order_date" BETWEEN $1 AND $2');
    expect(r.params).toEqual(["2025-01-01", "2025-12-31"]);
  });

  test("BETWEEN filter with malformed value is rejected", () => {
    expect(() => compileKpiQuery(
      {
        datasets: ["orders"],
        metric: "COUNT(1)",
        filters: [{ field: "orders.orderDate", op: "between", value: "2025" as unknown as { start: string; end: string } }],
      },
      "mysql",
      orderCatalog,
      "COUNT(1)",
    )).toThrow(/BAD_BETWEEN_VALUE/);
  });

  test("Multiple filters are joined with AND", () => {
    const r = compileKpiQuery(
      {
        datasets: ["orders"],
        metric: "COUNT(1)",
        filters: [
          { field: "orders.region", op: "eq", value: "EMEA" },
          { field: "orders.amount", op: "gt", value: 1000 },
        ],
      },
      "mysql",
      orderCatalog,
      "COUNT(1)",
    );
    expect(r.sql).toContain("`orders`.`region` = ?");
    expect(r.sql).toContain("`orders`.`amount` > ?");
    expect(r.params).toEqual(["EMEA", 1000]);
  });
});

// ===========================================================================
// compileKpiQuery — joins
// ===========================================================================

describe("compileKpiQuery — joins", () => {
  test("single LEFT JOIN compiles", () => {
    const r = compileKpiQuery(
      {
        datasets: ["orders", "customers"],
        metric: "SUM(amount)",
        joins: [{ type: "LEFT", leftTable: "orders", leftColumn: "customerId", rightTable: "customers", rightColumn: "id" }],
      },
      "mysql",
      orderCustomerCatalog,
      "SUM(amount)",
    );
    expect(r.sql).toContain("FROM `orders`");
    expect(r.sql).toContain("LEFT JOIN `customers` ON `orders`.`customer_id` = `customers`.`id`");
  });

  test("INNER / RIGHT / FULL are emitted verbatim", () => {
    for (const type of ["INNER", "RIGHT", "FULL"] as const) {
      const r = compileKpiQuery(
        {
          datasets: ["orders", "customers"],
          metric: "SUM(amount)",
          joins: [{ type, leftTable: "orders", leftColumn: "customerId", rightTable: "customers", rightColumn: "id" }],
        },
        "postgresql",
        orderCustomerCatalog,
        "SUM(amount)",
      );
      expect(r.sql).toContain(`${type} JOIN "customers"`);
    }
  });

  test("unknown join type is rejected", () => {
    expect(() => compileKpiQuery(
      {
        datasets: ["orders", "customers"],
        metric: "SUM(amount)",
        joins: [{ type: "OUTER" as any, leftTable: "orders", leftColumn: "customerId", rightTable: "customers", rightColumn: "id" }],
      },
      "mysql",
      orderCustomerCatalog,
      "SUM(amount)",
    )).toThrow(/BAD_JOIN_TYPE/);
  });

  test("self-join is rejected", () => {
    expect(() => compileKpiQuery(
      {
        datasets: ["orders", "customers"],
        metric: "SUM(amount)",
        joins: [{ type: "LEFT", leftTable: "orders", leftColumn: "id", rightTable: "orders", rightColumn: "id" }],
      },
      "mysql",
      orderCustomerCatalog,
      "SUM(amount)",
    )).toThrow(/SELF_JOIN/);
  });

  test("unknown join column is rejected", () => {
    expect(() => compileKpiQuery(
      {
        datasets: ["orders", "customers"],
        metric: "SUM(amount)",
        joins: [{ type: "LEFT", leftTable: "orders", leftColumn: "customerId", rightTable: "customers", rightColumn: "doesNotExist" }],
      },
      "mysql",
      orderCustomerCatalog,
      "SUM(amount)",
    )).toThrow(/UNKNOWN_JOIN_COLUMN/);
  });

  test("multi-table plan without joins is rejected", () => {
    expect(() => compileKpiQuery(
      { datasets: ["orders", "customers"], metric: "COUNT(1)" },
      "mysql",
      orderCustomerCatalog,
      "COUNT(1)",
    )).toThrow(/MULTI_TABLE_NEEDS_JOINS/);
  });
});

// ===========================================================================
// compileKpiQuery — date grain
// ===========================================================================

describe("compileKpiQuery — date grain", () => {
  test.each([
    ["mysql",      "DATE_FORMAT(`orders`.`order_date`"],
    ["postgresql", `DATE_TRUNC('month', "orders"."order_date")`],
    ["sqlserver",  `DATEFROMPARTS(YEAR([orders].[order_date]), MONTH([orders].[order_date]), 1)`],
    ["sqlite",     `strftime('%Y-%m-01', \`orders\`.\`order_date\`)`],
    ["snowflake",  `DATE_TRUNC('month', "orders"."order_date")`],
    ["databricks", `DATE_TRUNC('month', "orders"."order_date")`],
    ["bigquery",   `DATE_TRUNC(\`orders\`.\`order_date\`, MONTH)`],
  ] as Array<[DialectType, string]>)("month grain in %s", (dialect, expectedFragment) => {
    const r = compileKpiQuery(
      {
        datasets: ["orders"],
        metric: "SUM(amount)",
        timeGrain: "month",
        timeGrainColumn: "orders.orderDate",
      },
      dialect,
      orderCatalog,
      "SUM(amount)",
    );
    expect(r.sql).toContain(expectedFragment);
    expect(r.sql).toContain("GROUP BY");
    expect(r.sql).toContain("ORDER BY");
  });
});

// ===========================================================================
// compileKpiQuery — groupBy + sort
// ===========================================================================

describe("compileKpiQuery — groupBy + sort", () => {
  test("ascending sort", () => {
    const r = compileKpiQuery(
      {
        datasets: ["orders"],
        metric: "SUM(amount)",
        groupBy: ["orders.region"],
        sortDir: "asc",
      },
      "mysql",
      orderCatalog,
      "SUM(amount)",
    );
    expect(r.sql).toContain("ORDER BY `metric_value` ASC");
  });

  test("default sortDir is desc", () => {
    const r = compileKpiQuery(
      {
        datasets: ["orders"],
        metric: "SUM(amount)",
        groupBy: ["orders.region"],
      },
      "mysql",
      orderCatalog,
      "SUM(amount)",
    );
    expect(r.sql).toContain("ORDER BY `metric_value` DESC");
  });

  test("multi-column groupBy", () => {
    const r = compileKpiQuery(
      {
        datasets: ["orders"],
        metric: "SUM(amount)",
        groupBy: ["orders.region", "orders.amount"],
      },
      "mysql",
      orderCatalog,
      "SUM(amount)",
    );
    expect(r.sql).toContain("GROUP BY `orders`.`region`, `orders`.`amount`");
  });
});

// ===========================================================================
// compileKpiQuery — KPI inclusion / exclusion fragments
// ===========================================================================

describe("compileKpiQuery — KPI inclusions/exclusions", () => {
  test("inclusions are wrapped in parens and AND-joined", () => {
    const r = compileKpiQuery(
      { datasets: ["orders"], metric: "SUM(amount)" },
      "mysql",
      orderCatalog,
      "SUM(amount)",
      ["status = 'COMPLETED'", "currency = 'USD'"],
      [],
    );
    expect(r.sql).toContain("(status = 'COMPLETED')");
    expect(r.sql).toContain("(currency = 'USD')");
    expect(r.sql).toContain("WHERE");
  });

  test("exclusions are wrapped in NOT (...)", () => {
    const r = compileKpiQuery(
      { datasets: ["orders"], metric: "SUM(amount)" },
      "postgresql",
      orderCatalog,
      "SUM(amount)",
      [],
      ["is_test = true"],
    );
    expect(r.sql).toContain(`NOT (is_test = true)`);
  });

  test("empty fragments are skipped", () => {
    const r = compileKpiQuery(
      { datasets: ["orders"], metric: "SUM(amount)" },
      "mysql",
      orderCatalog,
      "SUM(amount)",
      ["", "  ", "valid_fragment = 1"],
      [],
    );
    expect(r.sql).not.toContain("( )");
    expect(r.sql).toContain("(valid_fragment = 1)");
  });
});

// ===========================================================================
// SQL injection defence
// ===========================================================================

describe("SQL injection defence", () => {
  test("malicious identifier is rejected at compile time", () => {
    const evil: ColumnResolver = (ref) => {
      if (ref === "orders.__table__") return { table: "orders; DROP TABLE users; --", column: "" };
      return null;
    };
    expect(() => compileKpiQuery(
      { datasets: ["orders"], metric: "COUNT(1)" },
      "mysql",
      evil,
      "COUNT(1)",
    )).toThrow(SqlCompileError);
  });

  test("filter value cannot escape into SQL", () => {
    const r = compileKpiQuery(
      {
        datasets: ["orders"],
        metric: "COUNT(1)",
        filters: [{ field: "orders.region", op: "eq", value: "EMEA'; DROP TABLE orders; --" }],
      },
      "mysql",
      orderCatalog,
      "COUNT(1)",
    );
    // The dangerous string is in params, never in sql.
    expect(r.sql).not.toContain("DROP TABLE");
    expect(r.params).toEqual(["EMEA'; DROP TABLE orders; --"]);
  });

  test("union-style fragment is rejected by SAFE_IDENTIFIER", () => {
    expect(() => compileKpiQuery(
      { datasets: ["orders"], metric: "SUM(amount)" },
      "mysql",
      orderCatalog,
      "1) UNION SELECT password FROM users --",
    )).toThrow(SqlCompileError);
  });

  test("filter op injection is rejected", () => {
    expect(() => compileKpiQuery(
      {
        datasets: ["orders"],
        metric: "COUNT(1)",
        filters: [{ field: "orders.region", op: "OR 1=1 --" as any, value: "x" }],
      },
      "mysql",
      orderCatalog,
      "COUNT(1)",
    )).toThrow();
  });
});

// ===========================================================================
// Plan shape validation
// ===========================================================================

describe("Plan shape validation", () => {
  test("no datasets → error", () => {
    expect(() => compileKpiQuery(
      { datasets: [], metric: "COUNT(1)" },
      "mysql",
      orderCatalog,
      "COUNT(1)",
    )).toThrow(/NO_DATASETS/);
  });

  test("unknown dataset → error", () => {
    expect(() => compileKpiQuery(
      { datasets: ["phantom"], metric: "COUNT(1)" },
      "mysql",
      orderCatalog,
      "COUNT(1)",
    )).toThrow(/UNKNOWN_DATASET/);
  });

  test("column from outside plan → error", () => {
    expect(() => compileKpiQuery(
      {
        datasets: ["orders"],
        metric: "COUNT(1)",
        filters: [{ field: "users.id", op: "eq", value: 1 }],
      },
      "mysql",
      (ref) => {
        if (ref === "orders.__table__") return { table: "orders", column: "" };
        if (ref === "users.id") return { table: "users", column: "id" };
        return null;
      },
      "COUNT(1)",
    )).toThrow(/COLUMN_OUTSIDE_PLAN/);
  });

  test("empty SELECT is rejected", () => {
    expect(() => compileKpiQuery(
      { datasets: ["orders"], metric: "" },
      "mysql",
      orderCatalog,
      "",
    )).toThrow(/EMPTY_SELECT/);
  });

  test("unsupported dialect is rejected", () => {
    expect(() => compileKpiQuery(
      { datasets: ["orders"], metric: "COUNT(1)" },
      "oracle" as unknown as DialectType,
      orderCatalog,
      "COUNT(1)",
    )).toThrow(/UNSUPPORTED_DIALECT/);
  });
});

// ===========================================================================
// Round-trip compatibility with CompiledQuery shape
// ===========================================================================

describe("CompiledQuery shape compatibility", () => {
  test("returned object matches the CompiledQuery type", () => {
    const r = compileKpiQuery(
      {
        datasets: ["orders"],
        metric: "SUM(amount)",
        groupBy: ["orders.region"],
        filters: [{ field: "orders.region", op: "eq", value: "EMEA" }],
        joins: [],
        limit: 10,
      },
      "mysql",
      orderCatalog,
      "SUM(amount)",
    );
    expect(r).toMatchObject({
      dialect: "mysql",
      sql: expect.any(String),
      params: ["EMEA"],
      dataset: "orders",
      metric: "SUM(amount)",
      groupBy: ["orders.region"],
      datasets: ["orders"],
      joins: [],
    });
    expect(r.sql).toContain("LIMIT 10");
  });

  test("Subquery rejection via CompileOptions", () => {
    const subqueryCatalog: ColumnResolver = (ref) => {
      if (ref === "orders.__table__") return { table: "(SELECT * FROM raw_orders) AS orders", column: "" };
      return null;
    };
    expect(() => compileKpiQuery(
      { datasets: ["orders"], metric: "COUNT(1)" },
      "mysql",
      subqueryCatalog,
      "COUNT(1)",
      [],
      [],
      { rejectSubquery: true },
    )).toThrow(/SUBQUERY_DISALLOWED/);
  });
});
