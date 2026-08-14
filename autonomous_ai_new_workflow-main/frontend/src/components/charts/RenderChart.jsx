
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  RadarController,
  RadialLinearScale,
  Title,
  Tooltip,
  Legend,
} from "chart.js";
import { Bar, Line, Radar } from "react-chartjs-2";
import "./RenderChart.css";
import ChartDataLabels from "chartjs-plugin-datalabels";
import { useThemeColor } from "../../hooks/useThemeColor";
import { toSafeText } from "../../utils/safeText";
import { formatMonthYear, formatNumber, toFiniteNumber } from "../../utils/formatters";
import InlineState from "../common/InlineState";

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,

  RadarController,
  RadialLinearScale,
  ChartDataLabels,
  Title,
  Tooltip,
  Legend,
);

const uniqueValues = (data, key) => [
  ...new Set(data.map((d) => d[key]).filter(Boolean)),
];

const average = (rows, metric) => {
  const values = rows
    .map((r) => Number(r[metric]))
    .filter((v) => Number.isFinite(v));

  return values.length
    ? values.reduce((sum, v) => sum + v, 0) / values.length
    : 0;
};

const getDimensionValues = (data, dimensionKey) => {
  return [...new Set(data.map((row) => row[dimensionKey]).filter(Boolean))];
};

const getGroupedDataByDimension = (
  dimensionKey,
  rawData,
  rawPreviousData,
  metric,
) => {
  const labels = uniqueValues(rawData, dimensionKey);

  return {
    dimension: dimensionKey,
    labels,

    current: labels.map((label) =>
      average(
        rawData.filter((d) => d[dimensionKey] === label),
        metric,
      ),
    ),

    previous: labels.map((label) =>
      average(
        rawPreviousData.filter((d) => d[dimensionKey] === label),
        metric,
      ),
    ),
  };
};

const render_Chart = ({ chartType, chartData, options, groupedData }) => {
  if (!chartData || !chartData.labels) return null;

  switch (chartType) {
    case "bar":
      return <Bar data={chartData} options={options} />;

    case "area":
      return <Line data={chartData} options={options} />;

    case "line":
      return <Line data={chartData} options={options} />;

    case "radar":
      return (
        <Radar
          data={chartData}
          options={{
            ...options,
            scales: {
              r: {
                beginAtZero: true,
                max:
                  (() => {
                    const vals = [...groupedData.current, ...groupedData.previous];
                    const peak = vals.length ? Math.max(...vals) : 0;
                    return peak === 0 ? 10 : peak * 1.1;
                  })(),
                ticks: {
                  display: false,
                },
                pointLabels: {
                  display: true,
                },
                grid: {
                  display: true,
                },
                angleLines: {
                  display: true,
                },
              },
            },
          }}
        />
      );

    default:
      return <Bar data={chartData} options={options} />;
  }
};

const RenderChart = ({ responseData }) => {
  const themePrimary = useThemeColor("--theme-primary", "#00D4FF");
  const themeAccent = useThemeColor("--theme-accent", "#0E1954");

  const themeText = useThemeColor("--theme-text", "#0f172a");
  const themeTextMuted = useThemeColor("--theme-text-muted", "#64748b");

  if (responseData?.data?.rows?.length && !responseData?.chart_suggestion) {
    const rows = responseData.data.rows.slice(0, 20);
    const firstRow = rows[0] || {};
    const firstKey = Object.keys(firstRow)[0] || "key";
    
    // Prefer 'value' for numeric, else search
    const numericKey = "value" in firstRow ? "value" :
      Object.keys(firstRow).find((key) => rows.some((row) => Number.isFinite(Number(row?.[key]))));
      
    if (!numericKey) {
      return (
        <InlineState
          type="empty"
          title="No numeric values to chart"
          message="The query returned rows, but none of the returned columns can be plotted."
        />
      );
    }
    // Prefer 'key' for label, else find non-numeric, else firstKey
    const labelKey = "key" in firstRow ? "key" : 
      (Object.keys(firstRow).find((key) => key !== numericKey) || firstKey);
    const chartType = responseData.chart?.type === "line" ? "line" : "bar";

    const chartData = {
      labels: rows.map((row) => toSafeText(row?.key ?? row?.[labelKey] ?? "")),
      datasets: [
        {
          label: toSafeText(responseData.semanticMatch?.metric || responseData.metric || "Value"),
          data: rows.map((row) => toFiniteNumber(row?.value ?? row?.[numericKey], null)),
          backgroundColor: themePrimary,
          borderColor: themePrimary,
          borderWidth: 2,
          borderRadius: 5,
          tension: 0.3,
        },
      ],
    };

    const options = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: toSafeText(responseData.insight?.answer || responseData.semanticMatch?.metric || "Query Result"),
          color: themeText,
        },
        tooltip: {
          callbacks: {
            label: (context) => `${context.dataset.label}: ${formatNumber(context.parsed.y)}`,
          },
        },
      },
      scales: {
        y: {
          beginAtZero: false,
          ticks: {
            callback: (value) => formatNumber(value),
            color: themeTextMuted,
          },
        },
        x: {
          ticks: { color: themeTextMuted },
        },
      },
    };

    return (
      <div style={{ padding: "20px", margin: "0 auto" }}>
        <div className="chart-card" style={{ height: 320 }}>
          {chartType === "line" ? <Line data={chartData} options={options} /> : <Bar data={chartData} options={options} />}
        </div>
      </div>
    );
  }

  const {
    chart_suggestion,
    data = [],
    previous_data = [],
    kpi_name: kpiName,
    periods = {},
  } = responseData;

  const metric = chart_suggestion?.kpi_col || "";
  const dimensions = chart_suggestion?.filters || [];

  const dimensionValuesMap = {};
  dimensions.forEach((dim) => {
    dimensionValuesMap[dim] = getDimensionValues(data, dim);
  });

  const chartsData = dimensions.map((dim) =>
    getGroupedDataByDimension(dim, data, previous_data, metric),
  );

  const isValidChartData = ({ labels, current, previous }) => {
    return (
      Array.isArray(labels) &&
      Array.isArray(current) &&
      Array.isArray(previous) &&
      labels.length > 0 &&
      current.length > 0 &&
      previous.length > 0
    );
  };

  const chartsOrder = ["bar", "line", "radar"];

  const chartsDataWithType = chartsData
    .filter(isValidChartData)
    .map((chartData, index) => {
      const labelLength = chartData.labels.length;

      const allowedCharts = [];

      allowedCharts.push("bar");

      if (labelLength >= 2) {
        allowedCharts.push("line");
      }

      if (labelLength >= 3 && labelLength <= 6) {
        allowedCharts.push("radar");
      }

      const rotatedPriority = chartsOrder
        .slice(index % chartsOrder.length)
        .concat(chartsOrder.slice(0, index % chartsOrder.length));

      const mappedType =
        rotatedPriority.find((type) => allowedCharts.includes(type)) || "bar";

      return {
        ...chartData,
        chartType: mappedType,
      };
    });

  const chartLabels = getMonthYearLabels(periods);

  return (
    <div style={{ padding: "20px", margin: "0 auto" }}>
      <div className="charts-grid">
        {chartsDataWithType.map((chart, idx) => {
          const chartData = {
            labels: chart.labels.map((label) => toSafeText(label)),
            datasets: [
              {
                label: toSafeText(chartLabels.current),
                data: chart.current,
                backgroundColor: themePrimary,
                borderColor: themePrimary,
                borderWidth: 2,
                borderRadius: 5,
                fill: chart.chartType === "area",
                datalabels:
                  chart.chartType !== "bar"
                    ? {
                        align: "top",
                        offset: 2,
                      }
                    : {
                        offset: -5,
                      },
              },
            ],
          };

          if (previous_data && previous_data.length > 0) {
            chartData.datasets.push({
              label: toSafeText(chartLabels.previous),
              data: chart.previous,
              backgroundColor: themeAccent,
              borderColor: themeAccent,
              borderWidth: 2,
              borderRadius: 5,
              fill: false,
              datalabels:
                chart.chartType !== "bar"
                  ? {
                      align: "bottom",
                      offset: 2,
                    }
                  : {
                      offset: -5,
                    },
            });
          }

          const options = {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              title: {
                display: true,
                text: `${toSafeText(kpiName)} - ${toSafeText(chart.dimension).replace("u_gsc_", "").toUpperCase()}`,
                color: themeText,
              },
              legend: { position: "top", labels: { color: themeText } },
              datalabels: {
                display: true,
                anchor: "end",
                align: "end",
                offset: 4,
                color: themeTextMuted,
                borderRadius: 8,
                font: {
                  size: 11,
                  weight: "600",
                },
                formatter: (value) => Number.isFinite(value) ? formatNumber(value) : "",
              },
            },
            scales:
              chart.chartType !== "radar" ? {
                y: {
                  beginAtZero: false,
                  ticks: {
                    callback: (value) => formatNumber(value),
                    color: themeTextMuted,
                  },
                },
                x: {
                  ticks: { color: themeTextMuted },
                },
              } : {},
          };

          return (
            <div
              key={idx}
              className="chart-card shadow-[0_8px_24px_rgba(0,0,0,0.12)]"
            >
              <div className="chart-wrapper">
                {render_Chart({
                  chartType: chart.chartType,
                  chartData,
                  options,
                  groupedData: chart,
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default RenderChart;



const getMonthYearLabels = (periods) => {
  const fallback = { current: "Current", previous: "Previous" };

  const startDate = periods?.current?.start;
  if (!startDate) return fallback;

  const current = new Date(startDate);

  if (isNaN(current)) return fallback;

  const previous = new Date(current);
  previous.setMonth(current.getMonth() - 1);

  return {
    current: formatMonthYear(current),
    previous: formatMonthYear(previous),
  };
};
