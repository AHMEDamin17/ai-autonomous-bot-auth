import type { RoutingEvalFixture } from "../../analytics/router/routingEval";

export const connectionRoutingFixtures: RoutingEvalFixture[] = [
  {
    question: "Show total revenue by region.",
    expectedConnectionId: 11,
    expectedDatasets: ["orders"],
  },
  {
    question: "How many support cases were resolved last month?",
    expectedConnectionId: 22,
    expectedDatasets: ["cases"],
  },
];
