export interface RoutingEvalFixture {
  question: string;
  expectedConnectionId: number;
  expectedDatasets: string[];
}

export interface RoutingEvalObservation {
  connectionId: number | null;
  datasets: string[];
}

export interface RoutingEvalMetrics {
  total: number;
  routingAccuracy: number;
  averageTableOverlap: number;
  observations: Array<{
    fixture: RoutingEvalFixture;
    observation: RoutingEvalObservation;
    routingCorrect: boolean;
    tableOverlap: number;
  }>;
}

function tableOverlap(expected: string[], actual: string[]): number {
  const expectedSet = new Set(expected.map((value) => value.toLowerCase()));
  if (expectedSet.size === 0) return 1;
  const actualSet = new Set(actual.map((value) => value.toLowerCase()));
  let matched = 0;
  for (const value of expectedSet) {
    if (actualSet.has(value)) matched += 1;
  }
  return matched / expectedSet.size;
}

export async function evaluateRoutingFixtures(
  fixtures: RoutingEvalFixture[],
  evaluate: (fixture: RoutingEvalFixture) => Promise<RoutingEvalObservation>,
): Promise<RoutingEvalMetrics> {
  const observations = [];
  for (const fixture of fixtures) {
    const observation = await evaluate(fixture);
    observations.push({
      fixture,
      observation,
      routingCorrect:
        observation.connectionId === fixture.expectedConnectionId,
      tableOverlap: tableOverlap(
        fixture.expectedDatasets,
        observation.datasets,
      ),
    });
  }
  const total = observations.length;
  return {
    total,
    routingAccuracy: total
      ? observations.filter((item) => item.routingCorrect).length / total
      : 1,
    averageTableOverlap: total
      ? observations.reduce((sum, item) => sum + item.tableOverlap, 0) / total
      : 1,
    observations,
  };
}
