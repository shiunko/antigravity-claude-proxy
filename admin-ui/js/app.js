/**
 * Main Application for Antigravity Proxy Admin
 */

// Main app component
function app() {
  return {
    // Auth state
    isAuthenticated: false,
    currentUser: null,
    authTab: 'login',

    // Login form
    loginForm: {
      username: '',
      password: '',
    },
    loginError: '',

    // Register form
    registerForm: {
      username: '',
      password: '',
      confirmPassword: '',
    },
    registerError: '',
    registerSuccess: '',

    // UI state
    isLoading: false,
    currentPage: 'dashboard',

    // Initialize
    async init() {
      // Check for existing token
      if (window.api.getToken()) {
        try {
          const user = await window.api.getCurrentUser();
          this.currentUser = user;
          this.isAuthenticated = true;
        } catch (error) {
          // Token invalid, clear it
          window.api.setToken(null);
        }
      }

      // Listen for navigation events
      this.$watch('currentPage', (page) => {
        // Refresh data when navigating
        this.$dispatch('page-changed', page);
      });
    },

    // Login
    async login() {
      this.loginError = '';
      this.isLoading = true;

      try {
        const result = await window.api.login(
          this.loginForm.username,
          this.loginForm.password
        );
        this.currentUser = result.user;
        this.isAuthenticated = true;
        this.loginForm = { username: '', password: '' };
      } catch (error) {
        this.loginError = error.message || '登录失败';
      } finally {
        this.isLoading = false;
      }
    },

    // Register
    async register() {
      this.registerError = '';
      this.registerSuccess = '';

      if (this.registerForm.password !== this.registerForm.confirmPassword) {
        this.registerError = '两次输入的密码不一致';
        return;
      }

      if (this.registerForm.password.length < 6) {
        this.registerError = '密码长度至少 6 位';
        return;
      }

      this.isLoading = true;

      try {
        await window.api.register(
          this.registerForm.username,
          this.registerForm.password
        );
        this.registerSuccess = '注册成功！请登录';
        this.registerForm = { username: '', password: '', confirmPassword: '' };
        // Switch to login tab
        setTimeout(() => {
          this.authTab = 'login';
          this.registerSuccess = '';
        }, 2000);
      } catch (error) {
        this.registerError = error.message || '注册失败';
      } finally {
        this.isLoading = false;
      }
    },

    // Logout
    logout() {
      window.api.logout();
      this.isAuthenticated = false;
      this.currentUser = null;
      this.currentPage = 'dashboard';
    },
  };
}

// Dashboard component
function dashboardComponent() {
  return {
    stats: {
      totalAccounts: 0,
      activeAccounts: 0,
      rateLimitedAccounts: 0,
      invalidAccounts: 0,
    },
    modelGroups: [],
    showApiKey: false,

    async init() {
      await this.loadData();
    },

    async loadData() {
      try {
        // Load accounts for stats
        const accounts = await window.api.getAccounts();
        this.stats.totalAccounts = accounts.length;
        this.stats.activeAccounts = accounts.filter(a => !a.is_invalid && !a.is_rate_limited).length;
        this.stats.rateLimitedAccounts = accounts.filter(a => a.is_rate_limited).length;
        this.stats.invalidAccounts = accounts.filter(a => a.is_invalid).length;

        // Load model groups
        this.modelGroups = await window.api.getModelGroups();
      } catch (error) {
        console.error('Failed to load dashboard data:', error);
      }
    },

    copyApiKey() {
      const apiKey = Alpine.store('app')?.currentUser?.api_key || this.$data.currentUser?.api_key;
      if (apiKey) {
        navigator.clipboard.writeText(apiKey);
        this.showToast('API Key 已复制到剪贴板', 'success');
      }
    },

    showToast(message, type = 'info') {
      // Simple toast implementation
      const toast = document.createElement('div');
      toast.className = `fixed top-4 right-4 px-6 py-3 rounded-lg shadow-lg z-50 ${
        type === 'success' ? 'bg-green-500' : type === 'error' ? 'bg-red-500' : 'bg-blue-500'
      } text-white`;
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    },
  };
}

// Accounts component
function accountsComponent() {
  return {
    accounts: [],
    accountLimits: {},
    showAddModal: false,
    addMethod: 'oauth',
    oauthLoading: false,
    isLoading: false,
    addError: '',

    manualForm: {
      email: '',
      refresh_token: '',
      project_id: '',
    },

    async init() {
      await this.refreshAccounts();
    },

    async refreshAccounts() {
      try {
        const [accounts, limitsData] = await Promise.all([
          window.api.getAccounts(),
          window.api.getAccountLimits().catch(e => ({ accounts: [] })) // Handle error gracefully
        ]);

        this.accounts = accounts;

        // Transform limits array into a map keyed by email for easy lookup
        this.accountLimits = {};
        if (limitsData && limitsData.accounts) {
          limitsData.accounts.forEach(acc => {
            this.accountLimits[acc.email] = acc;
          });
        }
      } catch (error) {
        console.error('Failed to load accounts:', error);
      }
    },

    getLimitInfo(email) {
      const accountLimit = this.accountLimits[email];
      if (!accountLimit || !accountLimit.limits) return [];

      return Object.entries(accountLimit.limits).map(([model, limit]) => {
        if (!limit) {
          return { model, remaining: 'N/A', remainingFraction: null };
        }
        return {
          model,
          ...limit
        };
      });
    },

    async startOAuth() {
      this.oauthLoading = true;
      this.addError = '';

      try {
        const result = await window.api.startOAuth();
        if (result.authUrl) {
          // Open OAuth URL in new window
          const authWindow = window.open(result.authUrl, 'oauth', 'width=600,height=700');
          const state = result.state;

          // Poll for completion
          const pollInterval = setInterval(async () => {
            try {
              let status = 'pending';
              let error = null;

              if (state) {
                try {
                  const statusResult = await window.api.checkOAuthStatus(state);
                  status = statusResult.status;
                  error = statusResult.error;
                } catch (e) {
                  // Session might be expired or invalid
                  status = 'unknown';
                }
              }

              if (status === 'completed') {
                clearInterval(pollInterval);
                this.oauthLoading = false;
                if (authWindow && !authWindow.closed) authWindow.close();
                await this.refreshAccounts();
                this.showAddModal = false;
                this.showToast('账户添加成功', 'success');
              } else if (status === 'error') {
                clearInterval(pollInterval);
                this.oauthLoading = false;
                if (authWindow && !authWindow.closed) authWindow.close();
                this.addError = error || 'OAuth 授权失败';
              } else if (authWindow.closed && status !== 'processing') {
                // User closed window manually and backend is not processing
                clearInterval(pollInterval);
                this.oauthLoading = false;
              }
            } catch (e) {
              console.error('OAuth poll error:', e);
            }
          }, 1000);

          // Timeout after 5 minutes
          setTimeout(() => {
            clearInterval(pollInterval);
            this.oauthLoading = false;
          }, 300000);
        }
      } catch (error) {
        this.addError = error.message || 'OAuth 启动失败';
        this.oauthLoading = false;
      }
    },

    async addManualAccount() {
      this.isLoading = true;
      this.addError = '';

      try {
        await window.api.addAccountManual(
          this.manualForm.email,
          this.manualForm.refresh_token,
          this.manualForm.project_id
        );
        this.showAddModal = false;
        this.manualForm = { email: '', refresh_token: '', project_id: '' };
        await this.refreshAccounts();
      } catch (error) {
        this.addError = error.message || '添加失败';
      } finally {
        this.isLoading = false;
      }
    },

    async verifyAccount(account) {
      try {
        await window.api.verifyAccount(account.id);
        await this.refreshAccounts();
        this.showToast('账户验证成功', 'success');
      } catch (error) {
        this.showToast(error.message || '验证失败', 'error');
      }
    },

    async deleteAccount(account) {
      if (!confirm(`确定要删除账户 ${account.email} 吗？`)) {
        return;
      }

      try {
        await window.api.deleteAccount(account.id);
        await this.refreshAccounts();
        this.showToast('账户已删除', 'success');
      } catch (error) {
        this.showToast(error.message || '删除失败', 'error');
      }
    },

    formatTime(timestamp) {
      if (!timestamp) return '-';
      const date = new Date(timestamp);
      const now = new Date();
      const diff = now - date;

      if (diff < 60000) return '刚刚';
      if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
      if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
      return date.toLocaleDateString('zh-CN');
    },

    showToast(message, type = 'info') {
      const toast = document.createElement('div');
      toast.className = `fixed top-4 right-4 px-6 py-3 rounded-lg shadow-lg z-50 ${
        type === 'success' ? 'bg-green-500' : type === 'error' ? 'bg-red-500' : 'bg-blue-500'
      } text-white`;
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    },
  };
}

// Model Groups component
function groupsComponent() {
  return {
    groups: [],
    showCreateModal: false,
    createForm: {
      alias: '',
      strategy: 'priority',
    },
    createError: '',

    availableModels: [], // Store available models

    addModelModal: {
      show: false,
      group: null,
      modelName: '',
      orderIndex: 0,
    },

    async init() {
      await Promise.all([
        this.loadGroups(),
        this.loadAvailableModels()
      ]);
    },

    async loadAvailableModels() {
      try {
        const limitsData = await window.api.getAccountLimits();

        // Extract unique models from limits data
        const models = new Set();
        if (limitsData && limitsData.accounts) {
          limitsData.accounts.forEach(acc => {
            if (acc.limits) {
              Object.keys(acc.limits).forEach(model => models.add(model));
            }
          });
        }

        // Convert to array and sort
        this.availableModels = Array.from(models).sort();

        // Add common models if list is empty (fallback)
        if (this.availableModels.length === 0) {
          this.availableModels = [
            'gemini-2.0-flash-exp',
            'gemini-1.5-pro',
            'gemini-1.5-flash',
            'claude-3-opus-20240229',
            'claude-3-sonnet-20240229',
            'claude-3-haiku-20240307'
          ];
        }
      } catch (error) {
        console.error('Failed to load available models:', error);
        // Fallback models
        this.availableModels = [
          'gemini-2.0-flash-exp',
          'gemini-1.5-pro',
          'gemini-1.5-flash'
        ];
      }
    },

    async loadGroups() {
      try {
        this.groups = await window.api.getModelGroups();
      } catch (error) {
        console.error('Failed to load groups:', error);
      }
    },

    async createGroup() {
      this.createError = '';

      try {
        await window.api.createModelGroup(
          this.createForm.alias,
          this.createForm.strategy
        );
        this.showCreateModal = false;
        this.createForm = { alias: '', strategy: 'priority' };
        await this.loadGroups();
      } catch (error) {
        this.createError = error.message || '创建失败';
      }
    },

    async deleteGroup(group) {
      if (!confirm(`确定要删除模型组 ${group.alias} 吗？`)) {
        return;
      }

      try {
        await window.api.deleteModelGroup(group.id);
        await this.loadGroups();
      } catch (error) {
        console.error('Failed to delete group:', error);
      }
    },

    editGroup(group) {
      // For now, just allow adding/removing models
      this.showAddModelModal(group);
    },

    showAddModelModal(group) {
      this.addModelModal = {
        show: true,
        group: group,
        modelName: '',
        orderIndex: group.items?.length || 0,
      };
    },

    async addModelToGroup() {
      try {
        await window.api.addModelToGroup(
          this.addModelModal.group.id,
          this.addModelModal.modelName,
          this.addModelModal.orderIndex
        );
        this.addModelModal.show = false;
        await this.loadGroups();
      } catch (error) {
        console.error('Failed to add model:', error);
      }
    },

    async removeModelFromGroup(group, modelName) {
      try {
        await window.api.removeModelFromGroup(group.id, modelName);
        await this.loadGroups();
      } catch (error) {
        console.error('Failed to remove model:', error);
      }
    },
  };
}

// Users component (admin only)
function usersComponent() {
  return {
    users: [],
    showCreateModal: false,
    createForm: {
      username: '',
      password: '',
      is_admin: false,
    },
    createError: '',

    async init() {
      await this.loadUsers();
    },

    async loadUsers() {
      try {
        this.users = await window.api.getUsers();
      } catch (error) {
        console.error('Failed to load users:', error);
      }
    },

    async createUser() {
      this.createError = '';

      try {
        await window.api.createUser(
          this.createForm.username,
          this.createForm.password,
          this.createForm.is_admin
        );
        this.showCreateModal = false;
        this.createForm = { username: '', password: '', is_admin: false };
        await this.loadUsers();
      } catch (error) {
        this.createError = error.message || '创建失败';
      }
    },

    async deleteUser(user) {
      if (!confirm(`确定要删除用户 ${user.username} 吗？`)) {
        return;
      }

      try {
        await window.api.deleteUser(user.id);
        await this.loadUsers();
      } catch (error) {
        console.error('Failed to delete user:', error);
      }
    },

    async regenerateKey(user) {
      if (!confirm(`确定要重置用户 ${user.username} 的 API Key 吗？`)) {
        return;
      }

      try {
        await window.api.regenerateUserKey(user.id);
        await this.loadUsers();
      } catch (error) {
        console.error('Failed to regenerate key:', error);
      }
    },

    formatDate(dateStr) {
      if (!dateStr) return '-';
      return new Date(dateStr).toLocaleDateString('zh-CN');
    },
  };
}

// Settings component
function settingsComponent() {
  return {
    passwordForm: {
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
    },
    passwordError: '',
    passwordSuccess: '',
    apiBaseUrl: window.api.baseUrl,

    async changePassword() {
      this.passwordError = '';
      this.passwordSuccess = '';

      if (this.passwordForm.newPassword !== this.passwordForm.confirmPassword) {
        this.passwordError = '两次输入的新密码不一致';
        return;
      }

      if (this.passwordForm.newPassword.length < 6) {
        this.passwordError = '新密码长度至少 6 位';
        return;
      }

      try {
        await window.api.changePassword(
          this.passwordForm.currentPassword,
          this.passwordForm.newPassword
        );
        this.passwordSuccess = '密码修改成功';
        this.passwordForm = { currentPassword: '', newPassword: '', confirmPassword: '' };
      } catch (error) {
        this.passwordError = error.message || '修改失败';
      }
    },
  };
}
