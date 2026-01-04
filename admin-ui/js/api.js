/**
 * API Client for Antigravity Proxy Admin
 * Uses Vite proxy in development, same origin in production
 */

class ApiClient {
  constructor() {
    // Use empty base URL - Vite proxy handles /admin/* routes
    this.baseUrl = "";
    this.token = localStorage.getItem("adminToken");
  }

  setToken(token) {
    this.token = token;
    if (token) {
      localStorage.setItem("adminToken", token);
    } else {
      localStorage.removeItem("adminToken");
    }
  }

  getToken() {
    return this.token;
  }

  async request(method, path, data = null) {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      "Content-Type": "application/json",
    };

    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    const options = {
      method,
      headers,
    };

    if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.body = JSON.stringify(data);
    }

    try {
      const response = await fetch(url, options);
      const contentType = response.headers.get('content-type');

      let result;
      if (contentType && contentType.includes('application/json')) {
        result = await response.json();
      } else {
        result = await response.text();
      }

      if (!response.ok) {
        throw new Error(result.error || result.message || `HTTP ${response.status}`);
      }

      return result;
    } catch (error) {
      console.error(`API Error [${method} ${path}]:`, error);
      throw error;
    }
  }

  // Auth endpoints
  async login(username, password) {
    const result = await this.request('POST', '/admin/auth/login', { username, password });
    if (result.token) {
      this.setToken(result.token);
    }
    return result;
  }

  async register(username, password) {
    return this.request('POST', '/admin/auth/register', { username, password });
  }

  async logout() {
    this.setToken(null);
  }

  async getCurrentUser() {
    return this.request('GET', '/admin/auth/me');
  }

  async changePassword(currentPassword, newPassword) {
    return this.request('POST', '/admin/auth/change-password', { currentPassword, newPassword });
  }

  // Account endpoints
  async getAccounts() {
    return this.request('GET', '/admin/accounts');
  }

  async getAccountLimits() {
    return this.request('GET', '/admin/accounts/limits?format=json');
  }

  async addAccountManual(email, refreshToken, projectId) {
    return this.request('POST', '/admin/accounts/manual', {
      email,
      refresh_token: refreshToken,
      project_id: projectId,
    });
  }

  async startOAuth() {
    return this.request('POST', '/admin/accounts/oauth/start');
  }

  async checkOAuthStatus(state) {
    return this.request('GET', `/admin/accounts/oauth/status/${state}`);
  }

  async verifyAccount(accountId) {
    return this.request('POST', `/admin/accounts/${accountId}/verify`);
  }

  async deleteAccount(accountId) {
    return this.request('DELETE', `/admin/accounts/${accountId}`);
  }

  // Model Group endpoints
  async getModelGroups() {
    return this.request('GET', '/admin/groups');
  }

  async createModelGroup(alias, strategy) {
    return this.request('POST', '/admin/groups', { alias, strategy });
  }

  async deleteModelGroup(groupId) {
    return this.request('DELETE', `/admin/groups/${groupId}`);
  }

  async addModelToGroup(groupId, modelName, orderIndex) {
    return this.request('POST', `/admin/groups/${groupId}/models`, {
      model_name: modelName,
      order_index: orderIndex,
    });
  }

  async removeModelFromGroup(groupId, modelName) {
    return this.request('DELETE', `/admin/groups/${groupId}/models/${encodeURIComponent(modelName)}`);
  }

  // User management endpoints (admin only)
  async getUsers() {
    return this.request('GET', '/admin/users');
  }

  async createUser(username, password, isAdmin = false) {
    return this.request('POST', '/admin/users', { username, password, is_admin: isAdmin });
  }

  async deleteUser(userId) {
    return this.request('DELETE', `/admin/users/${userId}`);
  }

  async regenerateUserKey(userId) {
    return this.request('POST', `/admin/users/${userId}/regenerate-key`);
  }

  // Stats endpoints
  async getStats() {
    return this.request('GET', '/admin/stats');
  }
}

// Global API client instance
window.api = new ApiClient();
