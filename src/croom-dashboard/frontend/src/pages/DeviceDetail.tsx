import { useState } from "react";
import { useAuthStore } from "../store/auth";
import { useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { devicesApi, metricsApi } from "../services/api";

export default function DeviceDetail() {
  const { id } = useParams<{ id: string }>();
  const client = useQueryClient();
  const { user } = useAuthStore();
  const canEdit = user?.role === "admin" || user?.role === "operator";
  const [name, setName] = useState<string | null>(null);
  const [location, setLocation] = useState<string | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (room: object) => devicesApi.update(id!, { config: { room } }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["device", id] });
      client.invalidateQueries({ queryKey: ["devices"] });
    },
  });
  const status = useMutation({
    mutationFn: () => devicesApi.sendCommand(id!, "get_status"),
  });

  const { data: device, isLoading } = useQuery({
    queryKey: ["device", id],
    queryFn: () => devicesApi.get(id!),
    enabled: !!id,
    refetchInterval: 10000,
  });

  const { data: metrics } = useQuery({
    queryKey: ["deviceMetrics", id],
    queryFn: () => metricsApi.getDeviceMetrics(id!),
    enabled: !!id,
    refetchInterval: 10000,
  });

  if (isLoading) {
    return <div className="text-gray-400">Loading...</div>;
  }

  if (!device) {
    return <div className="text-gray-400">Device not found</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">{device.roomName}</h1>
        <p className="text-gray-400">{device.location || "No location set"}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Device Info */}
        <div className="bg-gray-800 rounded-lg p-6">
          <h2 className="text-lg font-medium mb-4">Device Information</h2>
          <dl className="space-y-4">
            <div className="flex justify-between">
              <dt className="text-gray-400">Status</dt>
              <dd className="capitalize">{device.status}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Platform</dt>
              <dd>{device.platform}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Software Version</dt>
              <dd>{device.softwareVersion}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Last Seen</dt>
              <dd>{new Date(device.lastSeen).toLocaleString()}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Device ID</dt>
              <dd className="text-xs font-mono">{device.id}</dd>
            </div>
          </dl>
        </div>

        {/* Capabilities */}
        <div className="bg-gray-800 rounded-lg p-6">
          <h2 className="text-lg font-medium mb-4">Capabilities</h2>
          {device.capabilities &&
          Object.keys(device.capabilities).length > 0 ? (
            <pre className="text-sm text-gray-300 overflow-auto">
              {JSON.stringify(device.capabilities, null, 2)}
            </pre>
          ) : (
            <p className="text-gray-400">No capabilities reported</p>
          )}
        </div>

        {/* Actions */}
        <div className="bg-gray-800 rounded-lg p-6">
          <h2 className="text-lg font-medium mb-4">Actions</h2>
          <div className="space-y-3">
            <button
              onClick={() => status.mutate()}
              disabled={
                !canEdit || status.isPending || device.status !== "online"
              }
              className="w-full py-2 bg-blue-600 rounded disabled:opacity-50"
            >
              Read Device Status
            </button>
            {status.data && (
              <pre className="text-xs overflow-auto">
                {JSON.stringify(status.data.data, null, 2)}
              </pre>
            )}
            {status.isError && (
              <p role="alert">Device status request failed.</p>
            )}
            <label className="block">
              Room name
              <input
                className="block w-full bg-gray-700 p-2"
                value={name ?? device.roomName}
                onChange={(e) => setName(e.target.value)}
                disabled={!canEdit}
              />
            </label>
            <label className="block">
              Location
              <input
                className="block w-full bg-gray-700 p-2"
                value={location ?? device.location ?? ""}
                onChange={(e) => setLocation(e.target.value)}
                disabled={!canEdit}
              />
            </label>
            <label className="block">
              Timezone
              <input
                className="block w-full bg-gray-700 p-2"
                value={timezone ?? device.config?.room?.timezone ?? "UTC"}
                onChange={(e) => setTimezone(e.target.value)}
                disabled={!canEdit}
              />
            </label>
            <button
              onClick={() =>
                save.mutate({
                  name: name ?? device.roomName,
                  location: location ?? device.location ?? "",
                  timezone: timezone ?? device.config?.room?.timezone ?? "UTC",
                })
              }
              disabled={
                !canEdit || save.isPending || device.status !== "online"
              }
              className="w-full py-2 bg-blue-600 rounded disabled:opacity-50"
            >
              {save.isPending
                ? "Waiting for device…"
                : "Apply Room Configuration"}
            </button>
            {save.isSuccess && (
              <p role="status">Configuration applied by device.</p>
            )}
            {save.isError && (
              <p role="alert">
                Configuration was not confirmed. Check the connection and retry.
              </p>
            )}
          </div>
        </div>

        {/* Recent Metrics */}
        <div className="bg-gray-800 rounded-lg p-6">
          <h2 className="text-lg font-medium mb-4">Recent Activity</h2>
          {metrics?.metrics && metrics.metrics.length > 0 ? (
            <div className="space-y-2 max-h-64 overflow-auto">
              {metrics.metrics.slice(0, 10).map((m: any) => (
                <div
                  key={m.id}
                  className="text-sm border-b border-gray-700 pb-2"
                >
                  <span className="text-gray-400">
                    {new Date(m.timestamp).toLocaleTimeString()}
                  </span>
                  <span className="ml-2">{m.type}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-400">No recent activity</p>
          )}
        </div>
      </div>
    </div>
  );
}
