import { useAuthStore } from "../store/auth";

export default function Settings() {
  const { user } = useAuthStore();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-gray-400 mt-1">Dashboard configuration</p>
      </div>

      {/* Account */}
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-lg font-medium mb-4">Account</h2>
        <dl className="space-y-4">
          <div className="flex justify-between">
            <dt className="text-gray-400">Name</dt>
            <dd>{user?.name}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-400">Email</dt>
            <dd>{user?.email}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-400">Role</dt>
            <dd className="capitalize">{user?.role}</dd>
          </div>
        </dl>
      </div>

      {/* System Info */}
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-lg font-medium mb-4">System Information</h2>
        <dl className="space-y-4">
          <div className="flex justify-between">
            <dt className="text-gray-400">Dashboard Version</dt>
            <dd>2.0.0-dev</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-400">API Endpoint</dt>
            <dd className="text-xs font-mono">{window.location.origin}/api</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
